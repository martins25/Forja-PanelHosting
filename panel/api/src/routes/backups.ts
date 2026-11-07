import type { FastifyInstance } from "fastify";
import { createReadStream, existsSync, unlinkSync, statSync } from "node:fs";
import { eq, and, desc } from "drizzle-orm";
import type { AgentClient } from "../agent/client.js";
import { getDB } from "../db/connection.js";
import { backups, accounts, sites, databases } from "../db/schema.js";
import {
  requireSession,
  requireCSRF,
  requireAdmin,
  requireAccountAccess,
} from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";
import { fireAlert } from "../alerts/engine.js";
import { decryptSecret } from "../crypto/secrets.js";

interface BackupsOpts {
  agentClient: AgentClient;
}

function parseId(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const EXPORT_EXPIRY_MS = 15 * 60 * 1000; // 15 minutes
const EXPORTS_BASE = "/var/lib/forja/exports";

interface BackupCreateBody {
  scope: string;
}

interface ExportBody {
  site_id?: number;
}

interface RestoreBody {
  target: string;
  confirm: boolean;
}

export async function backupRoutes(
  app: FastifyInstance,
  opts: BackupsOpts,
) {
  const agent = opts.agentClient;

  // List backups for an account
  app.get(
    "/api/accounts/:accountId/backups",
    { preHandler: [requireSession, requireAccountAccess("accountId")] },
    async (request, reply) => {
      const accountId = parseId(
        (request.params as { accountId: string }).accountId,
      );
      if (!accountId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid account ID" } });
      }

      const db = getDB();
      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();
      if (!account) {
        return reply
          .status(404)
          .send({ error: { code: "ACCOUNT_NOT_FOUND", message: "Account not found" } });
      }

      const rows = db
        .select()
        .from(backups)
        .where(eq(backups.accountId, accountId))
        .orderBy(desc(backups.createdAt))
        .all();

      return rows;
    },
  );

  // Create backup (snapshot)
  app.post(
    "/api/accounts/:accountId/backups",
    { preHandler: [requireSession, requireCSRF, requireAccountAccess("accountId")] },
    async (request, reply) => {
      const accountId = parseId(
        (request.params as { accountId: string }).accountId,
      );
      if (!accountId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid account ID" } });
      }

      const body = request.body as BackupCreateBody;
      const scope = body.scope || "all";
      if (!["all", "sites", "databases"].includes(scope)) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "scope must be all, sites, or databases" },
        });
      }

      const db = getDB();
      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();
      if (!account) {
        return reply
          .status(404)
          .send({ error: { code: "ACCOUNT_NOT_FOUND", message: "Account not found" } });
      }

      const dbsForDump = getAccountDatabases(accountId);

      const row = db
        .insert(backups)
        .values({
          accountId,
          kind: "snapshot",
          includes: scope,
          status: "running",
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get();

      const agentRes = await agent.callAction<{
        restic_snapshot_id: string;
        size_bytes: number;
      }>("backup.run", {
        account_slug: account.slug,
        scope,
        databases: dbsForDump,
      });

      if (!agentRes.ok) {
        db.update(backups)
          .set({ status: "failed" })
          .where(eq(backups.id, row.id))
          .run();

        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "backup.run",
          targetType: "backup",
          targetId: String(row.id),
          result: "error",
          errorCode: agentRes.error?.code ?? "AGENT_ERROR",
        });

        fireAlert("backup_failed", {
          accountId,
          message: `Backup failed for account ${account.slug} (${agentRes.error?.code ?? "AGENT_ERROR"})`,
        });

        return reply.status(502).send({
          error: {
            code: agentRes.error?.code ?? "AGENT_ERROR",
            message: "Backup failed",
          },
        });
      }

      db.update(backups)
        .set({
          resticSnapshotId: agentRes.result!.restic_snapshot_id,
          sizeBytes: agentRes.result!.size_bytes,
          status: "completed",
        })
        .where(eq(backups.id, row.id))
        .run();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "backup.run",
        targetType: "backup",
        targetId: String(row.id),
        paramsRedacted: `scope=${scope}`,
        result: "ok",
      });

      const updated = db
        .select()
        .from(backups)
        .where(eq(backups.id, row.id))
        .get();

      return reply.status(201).send(updated);
    },
  );

  // Export (generate downloadable archive)
  app.post(
    "/api/accounts/:accountId/backups/export",
    { preHandler: [requireSession, requireCSRF, requireAccountAccess("accountId")] },
    async (request, reply) => {
      const accountId = parseId(
        (request.params as { accountId: string }).accountId,
      );
      if (!accountId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid account ID" } });
      }

      const body = request.body as ExportBody;

      const db = getDB();
      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();
      if (!account) {
        return reply
          .status(404)
          .send({ error: { code: "ACCOUNT_NOT_FOUND", message: "Account not found" } });
      }

      let siteDomain = "";
      if (body.site_id) {
        const siteId = typeof body.site_id === "number" ? body.site_id : Number(body.site_id);
        if (!Number.isInteger(siteId) || siteId <= 0) {
          return reply.status(400).send({
            error: { code: "INVALID_BODY", message: "Invalid site_id" },
          });
        }
        const site = db
          .select()
          .from(sites)
          .where(and(eq(sites.id, siteId), eq(sites.accountId, accountId)))
          .get();
        if (!site) {
          return reply.status(404).send({
            error: { code: "SITE_NOT_FOUND", message: "Site not found" },
          });
        }
        siteDomain = site.primaryDomain;
      }

      const dbsForDump = body.site_id
        ? []
        : getAccountDatabases(accountId);

      const agentRes = await agent.callAction<{
        path: string;
        token: string;
        size_bytes: number;
      }>("backup.export", {
        account_slug: account.slug,
        site_domain: siteDomain,
        databases: dbsForDump,
      });

      if (!agentRes.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "backup.export",
          targetType: "backup",
          targetId: String(accountId),
          paramsRedacted: `site_domain=${siteDomain || "all"}`,
          result: "error",
          errorCode: agentRes.error?.code ?? "AGENT_ERROR",
        });
        return reply.status(502).send({
          error: {
            code: agentRes.error?.code ?? "AGENT_ERROR",
            message: "Export failed",
          },
        });
      }

      const row = db
        .insert(backups)
        .values({
          accountId,
          siteId: body.site_id ?? null,
          kind: "export",
          sizeBytes: agentRes.result!.size_bytes,
          includes: siteDomain || "all",
          status: "completed",
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "backup.export",
        targetType: "backup",
        targetId: String(row.id),
        result: "ok",
      });

      return reply.status(201).send({
        ...row,
        download_token: agentRes.result!.token,
      });
    },
  );

  // Download export archive (single-use, expires in 15 min)
  app.get(
    "/api/accounts/:accountId/backups/export/:token",
    { preHandler: [requireSession, requireAccountAccess("accountId")] },
    async (request, reply) => {
      const accountId = parseId(
        (request.params as { accountId: string }).accountId,
      );
      const token = (request.params as { token: string }).token;

      if (!accountId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid account ID" } });
      }

      if (!/^[0-9a-f]{64}$/.test(token)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_TOKEN", message: "Invalid token" } });
      }

      const filePath = `${EXPORTS_BASE}/${token}.tar.gz`;

      if (!existsSync(filePath)) {
        return reply
          .status(404)
          .send({ error: { code: "EXPORT_NOT_FOUND", message: "Export not found or already downloaded" } });
      }

      const stat = statSync(filePath);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > EXPORT_EXPIRY_MS) {
        try { unlinkSync(filePath); } catch { /* ignore */ }
        return reply
          .status(410)
          .send({ error: { code: "EXPORT_EXPIRED", message: "Export link has expired" } });
      }

      const stream = createReadStream(filePath);

      reply.header("Content-Type", "application/gzip");
      reply.header("Content-Disposition", `attachment; filename="backup-${token.slice(0, 8)}.tar.gz"`);
      reply.header("Content-Length", stat.size);

      // Delete after sending
      stream.on("end", () => {
        try { unlinkSync(filePath); } catch { /* ignore */ }
      });

      return reply.send(stream);
    },
  );

  // Restore from backup
  app.post(
    "/api/accounts/:accountId/backups/:backupId/restore",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const accountId = parseId(
        (request.params as { accountId: string }).accountId,
      );
      const backupId = parseId(
        (request.params as { backupId: string }).backupId,
      );

      if (!accountId || !backupId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid ID" } });
      }

      const body = request.body as RestoreBody | undefined;
      if (!body || body.confirm !== true) {
        return reply.status(400).send({
          error: { code: "CONFIRM_REQUIRED", message: "confirm must be true" },
        });
      }

      const target = body!.target || "all";
      if (!/^(all|site:[a-z0-9]([a-z0-9.-]*[a-z0-9])?)$/.test(target)) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "Invalid target" },
        });
      }

      const db = getDB();
      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();
      if (!account) {
        return reply
          .status(404)
          .send({ error: { code: "ACCOUNT_NOT_FOUND", message: "Account not found" } });
      }

      const backup = db
        .select()
        .from(backups)
        .where(
          and(
            eq(backups.id, backupId),
            eq(backups.accountId, accountId),
          ),
        )
        .get();
      if (!backup) {
        return reply
          .status(404)
          .send({ error: { code: "BACKUP_NOT_FOUND", message: "Backup not found" } });
      }

      if (backup.kind !== "snapshot" || !backup.resticSnapshotId) {
        return reply.status(400).send({
          error: { code: "NOT_RESTORABLE", message: "Only snapshot backups can be restored" },
        });
      }

      const agentRes = await agent.callAction<{
        restored_to: string;
        restarted: string[];
      }>("backup.restore", {
        account_slug: account.slug,
        restic_snapshot_id: backup.resticSnapshotId,
        target,
        confirm: true,
      });

      if (!agentRes.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "backup.restore",
          targetType: "backup",
          targetId: String(backupId),
          result: "error",
          errorCode: agentRes.error?.code ?? "AGENT_ERROR",
        });
        return reply.status(502).send({
          error: {
            code: agentRes.error?.code ?? "AGENT_ERROR",
            message: "Restore failed",
          },
        });
      }

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "backup.restore",
        targetType: "backup",
        targetId: String(backupId),
        paramsRedacted: `target=${target}`,
        result: "ok",
      });

      return reply.send({
        ok: true,
        restored_to: agentRes.result!.restored_to,
        restarted: agentRes.result!.restarted,
      });
    },
  );

  function getAccountDatabases(accountId: number) {
    const db = getDB();
    const rows = db
      .select()
      .from(databases)
      .where(eq(databases.accountId, accountId))
      .all();

    return rows.map((row) => ({
      engine: row.engine,
      db_name: row.name,
      db_user: row.dbUser,
      db_password: decryptSecret(row.passwordEnc),
    }));
  }
}
