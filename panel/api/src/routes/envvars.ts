import type { FastifyInstance } from "fastify";
import { getDB } from "../db/connection.js";
import { envVars, sites } from "../db/schema.js";
import { eq, and } from "drizzle-orm";
import {
  requireSession,
  requireCSRF,
  getAccessibleAccountIds,
} from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";
import { encryptSecret, decryptSecret } from "../crypto/secrets.js";
import { isEnvValue } from "../validation.js";

const ENV_KEY_RE = /^(?!__proto__$)[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const MAX_VALUE_LENGTH = 8192;

/** Values land in a KEY=VALUE file: they must be a bounded string with no line breaks or NUL. */
function checkEnvValue(value: unknown): { code: string; message: string } | null {
  if (typeof value !== "string") {
    return { code: "INVALID_BODY", message: "value must be a string" };
  }
  if (value.length > MAX_VALUE_LENGTH) {
    return { code: "VALUE_TOO_LONG", message: `Value exceeds ${MAX_VALUE_LENGTH} characters` };
  }
  if (!isEnvValue(value)) {
    return { code: "INVALID_VALUE", message: "Value must not contain line breaks or null bytes" };
  }
  return null;
}

function maskValue(plaintext: string): string {
  if (plaintext.length <= 4) return "****";
  return "****" + plaintext.slice(-4);
}

export function loadDecryptedEnvVars(siteId: number): Record<string, string> {
  const db = getDB();
  const rows = db
    .select()
    .from(envVars)
    .where(eq(envVars.siteId, siteId))
    .all();
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = decryptSecret(row.valueEnc);
  }
  return result;
}

export async function envVarRoutes(app: FastifyInstance) {
  app.get(
    "/api/sites/:siteId/env",
    { preHandler: [requireSession] },
    async (request, reply) => {
      const { siteId: siteIdStr } = request.params as { siteId: string };
      const siteId = Number(siteIdStr);
      if (Number.isNaN(siteId)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid site ID" } });
      }

      const db = getDB();
      const site = db.select().from(sites).where(eq(sites.id, siteId)).get();
      if (!site) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }

      const accountIds = getAccessibleAccountIds(request.session!.user.id, request.session!.user.role);
      if (accountIds && !accountIds.includes(site.accountId)) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
      }

      const rows = db
        .select()
        .from(envVars)
        .where(eq(envVars.siteId, siteId))
        .all();

      const result = rows.map((row) => ({
        id: row.id,
        siteId: row.siteId,
        key: row.key,
        maskedValue: maskValue(decryptSecret(row.valueEnc)),
      }));

      return reply.send(result);
    },
  );

  app.post(
    "/api/sites/:siteId/env",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      const { siteId: siteIdStr } = request.params as { siteId: string };
      const siteId = Number(siteIdStr);
      if (Number.isNaN(siteId)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid site ID" } });
      }

      const body = (request.body ?? {}) as { key?: unknown; value?: unknown };
      if (!body.key || body.value === undefined || body.value === null) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "key and value are required" },
        });
      }

      if (typeof body.key !== "string" || !ENV_KEY_RE.test(body.key)) {
        return reply.status(400).send({
          error: { code: "INVALID_KEY", message: "Invalid env key format" },
        });
      }

      const valueError = checkEnvValue(body.value);
      if (valueError) return reply.status(400).send({ error: valueError });
      const value = body.value as string;

      const db = getDB();
      const site = db.select().from(sites).where(eq(sites.id, siteId)).get();
      if (!site) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }

      const accountIds = getAccessibleAccountIds(request.session!.user.id, request.session!.user.role);
      if (accountIds && !accountIds.includes(site.accountId)) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
      }

      const existing = db
        .select()
        .from(envVars)
        .where(and(eq(envVars.siteId, siteId), eq(envVars.key, body.key)))
        .get();
      if (existing) {
        return reply.status(409).send({
          error: { code: "DUPLICATE_KEY", message: "Key already exists for this site" },
        });
      }

      const valueEnc = encryptSecret(value);
      const row = db
        .insert(envVars)
        .values({ siteId, key: body.key, valueEnc })
        .returning()
        .get();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "env_var.create",
        targetType: "env_var",
        targetId: String(row.id),
        result: "ok",
      });

      return reply.status(201).send({
        id: row.id,
        siteId: row.siteId,
        key: row.key,
        maskedValue: maskValue(value),
      });
    },
  );

  app.patch(
    "/api/sites/:siteId/env/:varId",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      const { siteId: siteIdStr, varId: varIdStr } = request.params as {
        siteId: string;
        varId: string;
      };
      const siteId = Number(siteIdStr);
      const varId = Number(varIdStr);
      if (Number.isNaN(siteId) || Number.isNaN(varId)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid ID" } });
      }

      const body = (request.body ?? {}) as { key?: unknown; value?: unknown };
      if (body.value === undefined || body.value === null) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "value is required" },
        });
      }

      const valueError = checkEnvValue(body.value);
      if (valueError) return reply.status(400).send({ error: valueError });
      const value = body.value as string;

      if (body.key !== undefined && (typeof body.key !== "string" || !ENV_KEY_RE.test(body.key))) {
        return reply.status(400).send({
          error: { code: "INVALID_KEY", message: "Invalid env key format" },
        });
      }

      const db = getDB();

      const site = db.select().from(sites).where(eq(sites.id, siteId)).get();
      if (!site) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }
      const accountIds = getAccessibleAccountIds(request.session!.user.id, request.session!.user.role);
      if (accountIds && !accountIds.includes(site.accountId)) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
      }

      const row = db
        .select()
        .from(envVars)
        .where(and(eq(envVars.id, varId), eq(envVars.siteId, siteId)))
        .get();
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Env var not found" } });
      }

      const updates: { valueEnc: string; key?: string } = {
        valueEnc: encryptSecret(value),
      };
      if (body.key !== undefined) {
        const dup = db
          .select()
          .from(envVars)
          .where(
            and(
              eq(envVars.siteId, siteId),
              eq(envVars.key, body.key),
            ),
          )
          .get();
        if (dup && dup.id !== varId) {
          return reply.status(409).send({
            error: { code: "DUPLICATE_KEY", message: "Key already exists for this site" },
          });
        }
        updates.key = body.key;
      }

      db.update(envVars).set(updates).where(eq(envVars.id, varId)).run();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "env_var.update",
        targetType: "env_var",
        targetId: String(varId),
        result: "ok",
      });

      return reply.send({
        id: varId,
        siteId,
        key: body.key ?? row.key,
        maskedValue: maskValue(value),
      });
    },
  );

  app.delete(
    "/api/sites/:siteId/env/:varId",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      const { siteId: siteIdStr, varId: varIdStr } = request.params as {
        siteId: string;
        varId: string;
      };
      const siteId = Number(siteIdStr);
      const varId = Number(varIdStr);
      if (Number.isNaN(siteId) || Number.isNaN(varId)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid ID" } });
      }

      const db = getDB();

      const site = db.select().from(sites).where(eq(sites.id, siteId)).get();
      if (!site) {
        return reply.status(404).send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }
      const accountIds = getAccessibleAccountIds(request.session!.user.id, request.session!.user.role);
      if (accountIds && !accountIds.includes(site.accountId)) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
      }

      const row = db
        .select()
        .from(envVars)
        .where(and(eq(envVars.id, varId), eq(envVars.siteId, siteId)))
        .get();
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Env var not found" } });
      }

      db.delete(envVars).where(eq(envVars.id, varId)).run();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "env_var.delete",
        targetType: "env_var",
        targetId: String(varId),
        result: "ok",
      });

      return reply.status(204).send();
    },
  );
}
