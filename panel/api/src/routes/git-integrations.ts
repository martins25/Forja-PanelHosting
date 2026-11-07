import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { asc, eq } from "drizzle-orm";
import { getDB } from "../db/connection.js";
import { gitIntegrations, sites } from "../db/schema.js";
import {
  requireSession,
  requireCSRF,
} from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";
import {
  encryptSecret,
  decryptSecret,
  generateWebhookSecret,
} from "../crypto/secrets.js";

type IntegrationRow = typeof gitIntegrations.$inferSelect;

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan"];

const createSchema = z
  .object({
    provider: z.enum(["github", "gitea"]),
    baseUrl: z.string().trim().max(200).optional(),
    credentials: z.string().regex(/^[A-Za-z0-9_.-]{8,255}$/),
  })
  .strict();

/**
 * A Gitea base URL is just `https://host[:port]`: the agent only clones
 * public DNS hosts, so IP literals and local-only names are refused here too.
 */
export function normalizeGiteaBaseUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) return null;
  const host = url.hostname;
  if (!HOST_RE.test(host) || /^[0-9.]+$/.test(host)) return null;
  if (LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return null;
  return url.origin;
}

function parseId(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

/** Credentials never leave the API: only the last four characters are exposed. */
function toPublic(row: IntegrationRow) {
  return {
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl,
    ownerUserId: row.ownerUserId,
    credentialsLast4: decryptSecret(row.credentialsEnc).slice(-4),
    sitesCount: getDB()
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.gitIntegrationId, row.id))
      .all().length,
  };
}

export async function gitIntegrationRoutes(app: FastifyInstance) {
  // Admins manage every integration. Clients only see and manage their own,
  // and only GitHub ones: Gitea instances (arbitrary hosts) stay admin-only.
  const reads = { preHandler: [requireSession] };
  const writes = { preHandler: [requireSession, requireCSRF] };

  app.get("/api/git-integrations", reads, async (request) => {
    const { id: userId, role } = request.session!.user;
    const db = getDB();
    const rows =
      role === "admin"
        ? db.select().from(gitIntegrations).orderBy(asc(gitIntegrations.id)).all()
        : db
            .select()
            .from(gitIntegrations)
            .where(eq(gitIntegrations.ownerUserId, userId))
            .orderBy(asc(gitIntegrations.id))
            .all();
    return rows.map(toPublic);
  });

  app.post("/api/git-integrations", writes, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return sendError(reply, 400, "INVALID_BODY", "Invalid integration data");
    }
    const body = parsed.data;
    const actorUserId = request.session!.user.id;
    if (request.session!.user.role !== "admin" && body.provider !== "github") {
      return sendError(reply, 403, "FORBIDDEN", "Only admins can add Gitea integrations");
    }

    let baseUrl: string | null = null;
    if (body.provider === "gitea") {
      baseUrl = body.baseUrl ? normalizeGiteaBaseUrl(body.baseUrl) : null;
      if (!baseUrl) {
        return sendError(reply, 400, "INVALID_BASE_URL", "baseUrl must be https://host for a public Gitea instance");
      }
    } else if (body.baseUrl) {
      return sendError(reply, 400, "INVALID_BODY", "baseUrl is only valid for Gitea");
    }

    const db = getDB();
    if (baseUrl) {
      const duplicate = db
        .select({ id: gitIntegrations.id })
        .from(gitIntegrations)
        .where(eq(gitIntegrations.baseUrl, baseUrl))
        .get();
      if (duplicate) {
        return sendError(reply, 409, "DUPLICATE", "An integration for this instance already exists");
      }
    }

    const row = db
      .insert(gitIntegrations)
      .values({
        provider: body.provider,
        baseUrl,
        ownerUserId: actorUserId,
        credentialsEnc: encryptSecret(body.credentials),
        // Webhook secrets are per site; this column only needs a value.
        webhookSecretEnc: encryptSecret(generateWebhookSecret()),
      })
      .returning()
      .get();

    logAudit({
      actorUserId,
      actorKind: "user",
      action: "git_integration.create",
      targetType: "git_integration",
      targetId: String(row.id),
      paramsRedacted: JSON.stringify({ provider: body.provider, baseUrl }),
      result: "ok",
    });

    return reply.status(201).send(toPublic(row));
  });

  app.delete("/api/git-integrations/:id", writes, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (!id) return sendError(reply, 400, "INVALID_ID", "Invalid integration ID");
    const db = getDB();
    const row = db.select().from(gitIntegrations).where(eq(gitIntegrations.id, id)).get();
    if (!row) return sendError(reply, 404, "NOT_FOUND", "Git integration not found");
    if (request.session!.user.role !== "admin" && row.ownerUserId !== request.session!.user.id) {
      return sendError(reply, 403, "FORBIDDEN", "Access denied to this integration");
    }

    const used = db
      .select({ id: sites.id })
      .from(sites)
      .where(eq(sites.gitIntegrationId, id))
      .get();
    if (used) {
      return sendError(reply, 409, "IN_USE", "Sites still use this integration");
    }

    db.delete(gitIntegrations).where(eq(gitIntegrations.id, id)).run();
    logAudit({
      actorUserId: request.session!.user.id,
      actorKind: "user",
      action: "git_integration.delete",
      targetType: "git_integration",
      targetId: String(id),
      result: "ok",
    });
    return reply.status(204).send();
  });
}
