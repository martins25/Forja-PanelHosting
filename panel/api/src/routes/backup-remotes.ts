import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { and, asc, eq } from "drizzle-orm";
import type { AgentClient, AgentResponse } from "../agent/client.js";
import { getDB } from "../db/connection.js";
import { accounts, backupRemotes, backups } from "../db/schema.js";
import { requireSession, requireCSRF, requireAdmin } from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";
import { fireAlert } from "../alerts/engine.js";
import { encryptSecret, decryptSecret } from "../crypto/secrets.js";
import { agentErrorResponse } from "../agent/errors.js";

interface BackupRemotesOpts {
  agentClient: AgentClient;
}

type RemoteRow = typeof backupRemotes.$inferSelect;

// Mirrors agent/internal/validate (the agent validates again: this is only the
// first line of defence and gives the admin a useful 400).
const ENDPOINT_RE = /^https:\/\/([a-z0-9.-]+)(?::([0-9]{1,5}))?$/;
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION_RE = /^[a-z0-9][a-z0-9-]{1,29}$/;
const ACCESS_KEY_RE = /^[A-Za-z0-9_-]{8,128}$/;
const SECRET_KEY_RE = /^[A-Za-z0-9/+=_.-]{16,256}$/;

function isPublicHost(host: string): boolean {
  if (host.length > 253 || host.includes("..") || !host.includes(".")) return false;
  if (/^\d+(\.\d+)*$/.test(host)) return false;
  const last = host.slice(host.lastIndexOf(".") + 1);
  if (/^([0-9]+|0x[0-9a-f]*)$/.test(last)) return false;
  return ![".localhost", ".local", ".internal", ".lan"].some((s) => host.endsWith(s));
}

const endpointSchema = z.string().refine((v) => {
  const m = ENDPOINT_RE.exec(v);
  if (!m) return false;
  if (m[2] && (Number(m[2]) < 1 || Number(m[2]) > 65535)) return false;
  return isPublicHost(m[1]);
});

const fields = {
  name: z.string().trim().min(1).max(100),
  kind: z.enum(["s3", "r2"]),
  endpoint: endpointSchema,
  bucket: z.string().regex(BUCKET_RE).refine((v) => !v.includes("..")),
  region: z.string().regex(REGION_RE),
  access_key: z.string().regex(ACCESS_KEY_RE),
  secret_key: z.string().regex(SECRET_KEY_RE),
  enabled: z.boolean(),
};

const createSchema = z
  .object({
    name: fields.name,
    kind: fields.kind,
    endpoint: fields.endpoint,
    bucket: fields.bucket,
    region: fields.region,
    access_key: fields.access_key,
    secret_key: fields.secret_key,
    enabled: fields.enabled.optional(),
  })
  .strict();

const patchSchema = z
  .object({
    name: fields.name.optional(),
    kind: fields.kind.optional(),
    endpoint: fields.endpoint.optional(),
    bucket: fields.bucket.optional(),
    region: fields.region.optional(),
    access_key: fields.access_key.optional(),
    secret_key: fields.secret_key.optional(),
    enabled: fields.enabled.optional(),
  })
  .strict();

const syncSchema = z.object({ remote_id: z.number().int().positive().optional() }).strict();

const restoreSchema = z
  .object({
    remote_id: z.number().int().positive().optional(),
    backup_id: z.number().int().positive(),
    target: z.string().regex(/^(all|site:[a-z0-9]([a-z0-9.-]*[a-z0-9])?)$/).default("all"),
    confirm: z.literal(true),
  })
  .strict();

function parseId(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function last4(encrypted: string): string {
  return decryptSecret(encrypted).slice(-4);
}

/** Secrets never leave the API: only the last four characters are exposed. */
function toPublic(row: RemoteRow) {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    endpoint: row.endpoint,
    bucket: row.bucket,
    region: row.region,
    enabled: row.enabled,
    createdAt: row.createdAt,
    accessKeyLast4: last4(row.accessKeyEnc),
    secretKeyLast4: last4(row.secretKeyEnc),
  };
}

function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.status(status).send({ error: { code, message } });
}

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

/** The credentials are decrypted only here, to build the agent call. */
function remoteParams(row: RemoteRow) {
  return {
    remote_kind: row.kind,
    endpoint: row.endpoint,
    bucket: row.bucket,
    region: row.region,
    access_key: decryptSecret(row.accessKeyEnc),
    secret_key: decryptSecret(row.secretKeyEnc),
  };
}

export async function backupRemoteRoutes(app: FastifyInstance, opts: BackupRemotesOpts) {
  const agent = opts.agentClient;
  const reads = { preHandler: [requireSession, requireAdmin] };
  const writes = { preHandler: [requireSession, requireCSRF, requireAdmin] };

  app.get("/api/backup-remotes", reads, async () => {
    return getDB().select().from(backupRemotes).orderBy(asc(backupRemotes.id)).all().map(toPublic);
  });

  app.post("/api/backup-remotes", writes, async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_BODY", "Invalid remote data");
    const body = parsed.data;

    const row = getDB()
      .insert(backupRemotes)
      .values({
        name: body.name,
        kind: body.kind,
        endpoint: body.endpoint,
        bucket: body.bucket,
        region: body.region,
        accessKeyEnc: encryptSecret(body.access_key),
        secretKeyEnc: encryptSecret(body.secret_key),
        enabled: body.enabled ?? true,
        createdAt: new Date().toISOString(),
      })
      .returning()
      .get();

    logAudit({
      actorUserId: request.session!.user.id,
      actorKind: "user",
      action: "backup_remote.create",
      targetType: "backup_remote",
      targetId: String(row.id),
      result: "ok",
    });
    return reply.status(201).send(toPublic(row));
  });

  app.patch("/api/backup-remotes/:id", writes, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (!id) return sendError(reply, 400, "INVALID_ID", "Invalid remote ID");
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) return sendError(reply, 400, "INVALID_BODY", "Invalid remote data");
    const body = parsed.data;

    const db = getDB();
    const existing = db.select().from(backupRemotes).where(eq(backupRemotes.id, id)).get();
    if (!existing) return sendError(reply, 404, "NOT_FOUND", "Backup remote not found");

    const changes: Partial<typeof backupRemotes.$inferInsert> = {};
    if (body.name !== undefined) changes.name = body.name;
    if (body.kind !== undefined) changes.kind = body.kind;
    if (body.endpoint !== undefined) changes.endpoint = body.endpoint;
    if (body.bucket !== undefined) changes.bucket = body.bucket;
    if (body.region !== undefined) changes.region = body.region;
    if (body.enabled !== undefined) changes.enabled = body.enabled;
    if (body.access_key !== undefined) changes.accessKeyEnc = encryptSecret(body.access_key);
    if (body.secret_key !== undefined) changes.secretKeyEnc = encryptSecret(body.secret_key);

    const row =
      Object.keys(changes).length === 0
        ? existing
        : db.update(backupRemotes).set(changes).where(eq(backupRemotes.id, id)).returning().get();

    logAudit({
      actorUserId: request.session!.user.id,
      actorKind: "user",
      action: "backup_remote.update",
      targetType: "backup_remote",
      targetId: String(id),
      // Field names only: never the values.
      paramsRedacted: `fields=${Object.keys(body).join(",")}`,
      result: "ok",
    });
    return toPublic(row);
  });

  app.delete("/api/backup-remotes/:id", writes, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (!id) return sendError(reply, 400, "INVALID_ID", "Invalid remote ID");
    const db = getDB();
    const existing = db.select().from(backupRemotes).where(eq(backupRemotes.id, id)).get();
    if (!existing) return sendError(reply, 404, "NOT_FOUND", "Backup remote not found");

    db.delete(backupRemotes).where(eq(backupRemotes.id, id)).run();
    logAudit({
      actorUserId: request.session!.user.id,
      actorKind: "user",
      action: "backup_remote.delete",
      targetType: "backup_remote",
      targetId: String(id),
      result: "ok",
    });
    return reply.status(204).send();
  });

  // Connection test: opens (or creates) a data-less probe repository.
  app.post("/api/backup-remotes/:id/test", writes, async (request, reply) => {
    const id = parseId((request.params as { id: string }).id);
    if (!id) return sendError(reply, 400, "INVALID_ID", "Invalid remote ID");
    const row = getDB().select().from(backupRemotes).where(eq(backupRemotes.id, id)).get();
    if (!row) return sendError(reply, 404, "NOT_FOUND", "Backup remote not found");

    const res = await callAgent(agent, "backup.test_remote", remoteParams(row));
    if (!res.ok) {
      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "backup_remote.test",
        targetType: "backup_remote",
        targetId: String(id),
        result: "error",
        errorCode: res.error?.code ?? "AGENT_ERROR",
      });
      return agentErrorResponse(reply, res);
    }
    logAudit({
      actorUserId: request.session!.user.id,
      actorKind: "user",
      action: "backup_remote.test",
      targetType: "backup_remote",
      targetId: String(id),
      result: "ok",
    });
    return { ok: true };
  });

  /** Resolves the remote to use: the requested one, or the only enabled one. */
  function pickRemote(remoteId: number | undefined, reply: FastifyReply): RemoteRow | null {
    const db = getDB();
    if (remoteId !== undefined) {
      const row = db.select().from(backupRemotes).where(eq(backupRemotes.id, remoteId)).get();
      if (!row) {
        sendError(reply, 404, "NOT_FOUND", "Backup remote not found");
        return null;
      }
      if (!row.enabled) {
        sendError(reply, 409, "REMOTE_DISABLED", "Backup remote is disabled");
        return null;
      }
      return row;
    }
    const enabled = db.select().from(backupRemotes).where(eq(backupRemotes.enabled, true)).all();
    if (enabled.length === 0) {
      sendError(reply, 409, "NO_REMOTE", "No enabled backup remote is configured");
      return null;
    }
    if (enabled.length > 1) {
      sendError(reply, 409, "REMOTE_REQUIRED", "Several remotes are enabled: remote_id is required");
      return null;
    }
    return enabled[0];
  }

  app.post("/api/accounts/:accountId/backups/sync-remote", writes, async (request, reply) => {
    const accountId = parseId((request.params as { accountId: string }).accountId);
    if (!accountId) return sendError(reply, 400, "INVALID_ID", "Invalid account ID");
    const parsed = syncSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, "INVALID_BODY", "Invalid request");

    const account = getDB().select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account) return sendError(reply, 404, "ACCOUNT_NOT_FOUND", "Account not found");
    const remote = pickRemote(parsed.data.remote_id, reply);
    if (!remote) return;

    const res = await callAgent<{ remote: string; snapshots_copied: number }>(
      agent,
      "backup.sync_remote",
      { account_slug: account.slug, ...remoteParams(remote) },
    );
    const audit = { actorUserId: request.session!.user.id, actorKind: "user" as const };
    if (!res.ok) {
      logAudit({
        ...audit,
        action: "backup.sync_remote",
        targetType: "account",
        targetId: String(accountId),
        paramsRedacted: `remote_id=${remote.id}`,
        result: "error",
        errorCode: res.error?.code ?? "AGENT_ERROR",
      });
      fireAlert("backup_failed", {
        accountId,
        message: `Remote backup sync failed for account ${account.slug} (${res.error?.code ?? "AGENT_ERROR"})`,
      });
      return agentErrorResponse(reply, res);
    }
    logAudit({
      ...audit,
      action: "backup.sync_remote",
      targetType: "account",
      targetId: String(accountId),
      paramsRedacted: `remote_id=${remote.id}`,
      result: "ok",
    });
    return { ok: true, snapshotsCopied: res.result?.snapshots_copied ?? 0 };
  });

  app.post("/api/accounts/:accountId/backups/restore-remote", writes, async (request, reply) => {
    const accountId = parseId((request.params as { accountId: string }).accountId);
    if (!accountId) return sendError(reply, 400, "INVALID_ID", "Invalid account ID");
    const parsed = restoreSchema.safeParse(request.body ?? {});
    if (!parsed.success) return sendError(reply, 400, "INVALID_BODY", "Invalid request");
    const body = parsed.data;

    const db = getDB();
    const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
    if (!account) return sendError(reply, 404, "ACCOUNT_NOT_FOUND", "Account not found");
    const backup = db
      .select()
      .from(backups)
      .where(and(eq(backups.id, body.backup_id), eq(backups.accountId, accountId)))
      .get();
    if (!backup) return sendError(reply, 404, "BACKUP_NOT_FOUND", "Backup not found");
    if (backup.kind !== "snapshot" || !backup.resticSnapshotId) {
      return sendError(reply, 400, "NOT_RESTORABLE", "Only snapshot backups can be restored");
    }
    const remote = pickRemote(body.remote_id, reply);
    if (!remote) return;

    const res = await callAgent<{ restored_to: string; restarted: string[] }>(
      agent,
      "backup.restore_remote",
      {
        account_slug: account.slug,
        restic_snapshot_id: backup.resticSnapshotId,
        target: body.target,
        confirm: true,
        ...remoteParams(remote),
      },
    );
    const audit = {
      actorUserId: request.session!.user.id,
      actorKind: "user" as const,
      action: "backup.restore_remote",
      targetType: "backup",
      targetId: String(backup.id),
      paramsRedacted: `remote_id=${remote.id} target=${body.target}`,
    };
    if (!res.ok) {
      logAudit({ ...audit, result: "error", errorCode: res.error?.code ?? "AGENT_ERROR" });
      return agentErrorResponse(reply, res);
    }
    logAudit({ ...audit, result: "ok" });
    return {
      ok: true,
      restored_to: res.result?.restored_to,
      restarted: res.result?.restarted ?? [],
    };
  });
}
