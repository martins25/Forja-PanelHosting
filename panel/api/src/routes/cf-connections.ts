import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { asc, eq, inArray } from "drizzle-orm";
import type { AgentClient, AgentResponse } from "../agent/client.js";
import { getDB } from "../db/connection.js";
import { accounts, cfConnections, domains, sites } from "../db/schema.js";
import {
  requireSession,
  requireCSRF,
} from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";
import { encryptSecret, decryptSecret } from "../crypto/secrets.js";
import { agentErrorResponse } from "../agent/errors.js";

interface CfConnectionsOpts {
  agentClient: AgentClient;
}

type ConnectionRow = typeof cfConnections.$inferSelect;

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    cf_account_id: z.string().regex(/^[0-9a-f]{32}$/),
    api_token: z.string().regex(/^[A-Za-z0-9_-]{20,256}$/),
    tunnel_id: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    tunnel_token: z.string().regex(/^[A-Za-z0-9+/=_-]{20,2048}$/),
  })
  .strict();

const linkSchema = z.object({ accountId: z.number().int().positive() }).strict();

function parseId(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** The tunnel id embedded in a cloudflared token: base64(JSON{"a","t","s"}). */
function tunnelIdFromToken(token: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as {
      t?: unknown;
    };
    return typeof payload.t === "string" ? payload.t : null;
  } catch {
    return null;
  }
}

function last4(encrypted: string | null): string | null {
  if (!encrypted) return null;
  return decryptSecret(encrypted).slice(-4);
}

function linkedAccounts(connectionId: number) {
  return getDB()
    .select({ id: accounts.id, slug: accounts.slug })
    .from(accounts)
    .where(eq(accounts.cfConnectionId, connectionId))
    .orderBy(asc(accounts.id))
    .all();
}

/** Secrets never leave the API: only the last four characters are exposed. */
function toPublic(row: ConnectionRow) {
  return {
    id: row.id,
    name: row.name,
    ownerUserId: row.ownerUserId,
    managedBy: row.managedBy,
    cfAccountId: row.cfAccountId,
    tunnelId: row.tunnelId,
    status: row.status,
    apiTokenLast4: last4(row.apiTokenEnc),
    tunnelTokenLast4: last4(row.tunnelTokenEnc),
    accounts: linkedAccounts(row.id),
  };
}

function setStatus(id: number, status: string) {
  getDB().update(cfConnections).set({ status }).where(eq(cfConnections.id, id)).run();
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

/**
 * Agent messages can carry internal paths, podman output or Cloudflare API
 * details, so only a known code and a fixed message reach the browser.
 */
function agentFailure(reply: FastifyReply, res: AgentResponse) {
  return agentErrorResponse(reply, res);
}

function notFound(reply: FastifyReply) {
  return sendError(reply, 404, "NOT_FOUND", "Cloudflare connection not found");
}

/** Calls the agent; an unreachable agent is reported like an agent error. */
async function callAgent<T>(
  agent: AgentClient,
  action: string,
  params: Record<string, unknown>,
): Promise<AgentResponse<T>> {
  try {
    return await agent.callAction<T>(action, params);
  } catch {
    return {
      ok: false,
      error: { code: "AGENT_UNREACHABLE", message: "Agent is not reachable" },
    };
  }
}

export async function cfConnectionRoutes(
  app: FastifyInstance,
  opts: CfConnectionsOpts,
) {
  const agent = opts.agentClient;
  const reads = { preHandler: [requireSession] };
  const writes = { preHandler: [requireSession, requireCSRF] };

  app.get("/api/cf-connections", reads, async (request) => {
    const db = getDB();
    const isAdmin = request.session!.user.role === "admin";
    const rows = isAdmin
      ? db.select().from(cfConnections).orderBy(asc(cfConnections.id)).all()
      : db.select().from(cfConnections).where(eq(cfConnections.ownerUserId, request.session!.user.id)).orderBy(asc(cfConnections.id)).all();
    return rows.map(toPublic);
  });

  app.get("/api/cf-connections/:id", reads, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (!id) return sendError(reply, 400, "INVALID_ID", "Invalid connection ID");
    const row = getDB().select().from(cfConnections).where(eq(cfConnections.id, id)).get();
    if (!row) return notFound(reply);
    if (request.session!.user.role !== "admin" && row.ownerUserId !== request.session!.user.id) {
      return sendError(reply, 403, "FORBIDDEN", "Access denied to this connection");
    }
    return toPublic(row);
  });

  function checkConnectionOwner(request: import("fastify").FastifyRequest, row: ConnectionRow, reply: FastifyReply): boolean {
    if (request.session!.user.role === "admin") return true;
    if (row.ownerUserId === request.session!.user.id) return true;
    sendError(reply, 403, "FORBIDDEN", "Access denied to this connection");
    return false;
  }

  app.post("/api/cf-connections", writes, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_BODY", "Invalid connection data");
    }
    const body = parsed.data;
    const actorUserId = request.session!.user.id;

    if (tunnelIdFromToken(body.tunnel_token) !== body.tunnel_id) {
      return sendError(reply, 400, "TUNNEL_MISMATCH", "Tunnel token does not belong to tunnel_id");
    }

    const db = getDB();
    const existing = db
      .select({ id: cfConnections.id })
      .from(cfConnections)
      .where(eq(cfConnections.tunnelId, body.tunnel_id))
      .get();
    if (existing) {
      return sendError(reply, 409, "TUNNEL_IN_USE", "A connection for this tunnel already exists");
    }

    const row = db
      .insert(cfConnections)
      .values({
        name: body.name,
        ownerUserId: actorUserId,
        cfAccountId: body.cf_account_id,
        apiTokenEnc: encryptSecret(body.api_token),
        tunnelId: body.tunnel_id,
        tunnelTokenEnc: encryptSecret(body.tunnel_token),
        managedBy: request.session!.user.role === "admin" ? "admin" : "client",
        status: "pending",
      })
      .returning()
      .get();

    logAudit({
      actorUserId,
      actorKind: "user",
      action: "cf_connection.create",
      targetType: "cf_connection",
      targetId: String(row.id),
      result: "ok",
    });

    return reply.status(201).send(toPublic(row));
  });

  app.post("/api/cf-connections/:id/accounts", writes, async (request, reply) => {
    if (request.session!.user.role !== "admin") {
      return sendError(reply, 403, "FORBIDDEN", "Admin access required");
    }
    const id = parseId((request.params as { id: string }).id);
    if (!id) return sendError(reply, 400, "INVALID_ID", "Invalid connection ID");
    const parsed = linkSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_BODY", "accountId is required");

    const db = getDB();
    const row = db.select().from(cfConnections).where(eq(cfConnections.id, id)).get();
    if (!row) return notFound(reply);
    const account = db.select().from(accounts).where(eq(accounts.id, parsed.data.accountId)).get();
    if (!account) return sendError(reply, 404, "ACCOUNT_NOT_FOUND", "Account not found");
    if (account.cfConnectionId !== null && account.cfConnectionId !== id) {
      return sendError(reply, 409, "ALREADY_LINKED", "Account is linked to another connection");
    }
    // One account per connection: the account that runs cloudflared can read its
    // tunnel token, so the tunnel must not serve domains of any other account.
    if (linkedAccounts(id).some((a) => a.id !== account.id)) {
      return sendError(reply, 409, "CONNECTION_HAS_ACCOUNT", "Connection already has an account linked");
    }
    // The previous host account already read the tunnel token and could keep
    // connecting to the tunnel: a different account needs a new tunnel.
    if (row.hostAccountId !== null && row.hostAccountId !== account.id) {
      return sendError(reply, 409, "TOKEN_EXPOSED", "The tunnel token was deployed to another account: create a new tunnel for this one");
    }

    try {
      db.update(accounts).set({ cfConnectionId: id }).where(eq(accounts.id, account.id)).run();
    } catch {
      // The unique index is the last line of defence against concurrent links.
      return sendError(reply, 409, "CONNECTION_HAS_ACCOUNT", "Connection already has an account linked");
    }
    logAudit({
      actorUserId: request.session!.user.id,
      actorKind: "user",
      action: "cf_connection.link_account",
      targetType: "cf_connection",
      targetId: String(id),
      result: "ok",
    });
    return toPublic(row);
  });

  app.delete(
    "/api/cf-connections/:id/accounts/:accountId",
    writes,
    async (request, reply) => {
      if (request.session!.user.role !== "admin") {
        return sendError(reply, 403, "FORBIDDEN", "Admin access required");
      }
      const params = request.params as { id: string; accountId: string };
      const id = parseId(params.id);
      const accountId = parseId(params.accountId);
      if (!id || !accountId) return sendError(reply, 400, "INVALID_ID", "Invalid ID");

      const db = getDB();
      const row = db.select().from(cfConnections).where(eq(cfConnections.id, id)).get();
      if (!row) return notFound(reply);
      const linked = linkedAccounts(id);
      const account = linked.find((a) => a.id === accountId);
      if (!account) return sendError(reply, 404, "ACCOUNT_NOT_FOUND", "Account is not linked to this connection");

      // The container runs as the first linked account: stop it before it loses its host.
      const isHost = linked[0].id === accountId;
      if (isHost) {
        const res = await callAgent(agent, "cf.connection.apply", {
          account_slug: account.slug,
          connection_id: id,
          state: "absent",
        });
        if (!res.ok) {
          logAudit({
            actorUserId: request.session!.user.id,
            actorKind: "user",
            action: "cf_connection.unlink_account",
            targetType: "cf_connection",
            targetId: String(id),
            result: "error",
            errorCode: res.error?.code ?? "AGENT_ERROR",
          });
          return agentFailure(reply, res);
        }
        setStatus(id, "stopped");
      }

      db.update(accounts).set({ cfConnectionId: null }).where(eq(accounts.id, accountId)).run();
      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "cf_connection.unlink_account",
        targetType: "cf_connection",
        targetId: String(id),
        result: "ok",
      });
      return toPublic(db.select().from(cfConnections).where(eq(cfConnections.id, id)).get()!);
    },
  );

  app.post("/api/cf-connections/:id/apply", writes, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (!id) return sendError(reply, 400, "INVALID_ID", "Invalid connection ID");
    const db = getDB();
    const row = db.select().from(cfConnections).where(eq(cfConnections.id, id)).get();
    if (!row) return notFound(reply);
    if (!checkConnectionOwner(request, row, reply)) return;
    if (!row.tunnelId || !row.tunnelTokenEnc) {
      return sendError(reply, 409, "NO_TUNNEL", "Connection has no tunnel configured");
    }
    const host = linkedAccounts(id)[0];
    if (!host) {
      return sendError(reply, 409, "NO_ACCOUNT", "Link an account first: the container runs as one of its accounts");
    }

    if (row.hostAccountId !== null && row.hostAccountId !== host.id) {
      return sendError(reply, 409, "TOKEN_EXPOSED", "The tunnel token was deployed to another account: create a new tunnel for this one");
    }
    // Recorded before calling the agent: it may write the token file even if the
    // container then fails to start.
    if (row.hostAccountId === null) {
      db.update(cfConnections).set({ hostAccountId: host.id }).where(eq(cfConnections.id, id)).run();
    }

    const res = await callAgent(agent, "cf.connection.apply", {
      account_slug: host.slug,
      connection_id: id,
      state: "present",
      tunnel_id: row.tunnelId,
      tunnel_token: decryptSecret(row.tunnelTokenEnc),
    });

    const actorUserId = request.session!.user.id;
    if (!res.ok) {
      setStatus(id, "error");
      logAudit({
        actorUserId,
        actorKind: "user",
        action: "cf_connection.apply",
        targetType: "cf_connection",
        targetId: String(id),
        result: "error",
        errorCode: res.error?.code ?? "AGENT_ERROR",
      });
      return agentFailure(reply, res);
    }

    setStatus(id, "running");
    logAudit({
      actorUserId,
      actorKind: "user",
      action: "cf_connection.apply",
      targetType: "cf_connection",
      targetId: String(id),
      result: "ok",
    });
    return toPublic(db.select().from(cfConnections).where(eq(cfConnections.id, id)).get()!);
  });

  app.post("/api/cf-connections/:id/sync-routes", writes, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (!id) return sendError(reply, 400, "INVALID_ID", "Invalid connection ID");
    const db = getDB();
    const row = db.select().from(cfConnections).where(eq(cfConnections.id, id)).get();
    if (!row) return notFound(reply);
    if (!checkConnectionOwner(request, row, reply)) return;
    if (!row.tunnelId) {
      return sendError(reply, 409, "NO_TUNNEL", "Connection has no tunnel configured");
    }

    const accountIds = linkedAccounts(id).map((a) => a.id);
    const hostnames = accountIds.length
      ? db
          .select({ hostname: domains.hostname })
          .from(domains)
          .innerJoin(sites, eq(domains.siteId, sites.id))
          .where(inArray(sites.accountId, accountIds))
          .all()
          .map((d) => d.hostname)
      : [];

    const res = await callAgent<{
      domains: { hostname: string; status: string; code?: string }[];
      failed: number;
    }>(agent, "cf.routes.sync", {
      connection_id: id,
      cf_account_id: row.cfAccountId,
      tunnel_id: row.tunnelId,
      api_token: decryptSecret(row.apiTokenEnc),
      domains: [...new Set(hostnames)],
    });

    const actorUserId = request.session!.user.id;
    if (!res.ok || !res.result) {
      logAudit({
        actorUserId,
        actorKind: "user",
        action: "cf_connection.sync_routes",
        targetType: "cf_connection",
        targetId: String(id),
        result: "error",
        errorCode: res.error?.code ?? "AGENT_ERROR",
      });
      return agentFailure(reply, res);
    }

    logAudit({
      actorUserId,
      actorKind: "user",
      action: "cf_connection.sync_routes",
      targetType: "cf_connection",
      targetId: String(id),
      result: res.result.failed === 0 ? "ok" : "error",
      errorCode: res.result.failed === 0 ? undefined : "PARTIAL_SYNC",
    });
    return { domains: res.result.domains, failed: res.result.failed };
  });

  app.delete("/api/cf-connections/:id", writes, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (!id) return sendError(reply, 400, "INVALID_ID", "Invalid connection ID");
    const db = getDB();
    const row = db.select().from(cfConnections).where(eq(cfConnections.id, id)).get();
    if (!row) return notFound(reply);
    if (!checkConnectionOwner(request, row, reply)) return;

    // Unlinking the host account stops the container, so a connection with no
    // accounts has no container left to stop.
    if (linkedAccounts(id).length > 0) {
      return sendError(reply, 409, "HAS_ACCOUNTS", "Unlink the accounts first (this stops the container)");
    }

    db.delete(cfConnections).where(eq(cfConnections.id, id)).run();
    logAudit({
      actorUserId: request.session!.user.id,
      actorKind: "user",
      action: "cf_connection.delete",
      targetType: "cf_connection",
      targetId: String(id),
      result: "ok",
    });
    return reply.status(204).send();
  });
}
