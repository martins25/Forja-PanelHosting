import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { eq, and, count } from "drizzle-orm";
import type { AgentClient } from "../agent/client.js";
import { getDB } from "../db/connection.js";
import { databases, accounts } from "../db/schema.js";
import { checkPlanLimit } from "../plans/limits.js";
import {
  requireSession,
  requireCSRF,
  requireAccountAccess,
} from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";
import { isDbIdentifier } from "../validation.js";
import { encryptSecret, decryptSecret } from "../crypto/secrets.js";
import { agentErrorResponse } from "../agent/errors.js";

interface DatabasesOpts {
  agentClient: AgentClient;
}

const validEngines = ["mariadb", "mysql", "postgres"] as const;
const validTools = ["phpmyadmin", "adminer", "pgadmin"] as const;

function parseId(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function last4(encrypted: string): string {
  return decryptSecret(encrypted).slice(-4);
}

function toPublic(row: typeof databases.$inferSelect) {
  return {
    id: row.id,
    accountId: row.accountId,
    engine: row.engine,
    name: row.name,
    dbUser: row.dbUser,
    passwordLast4: last4(row.passwordEnc),
    webTool: row.webTool,
  };
}

interface CreateDBBody {
  engine: string;
  name: string;
  db_user: string;
}

interface ToolStartBody {
  tool: string;
}

export async function databaseRoutes(
  app: FastifyInstance,
  opts: DatabasesOpts,
) {
  const agent = opts.agentClient;

  // List databases for an account
  app.get(
    "/api/accounts/:accountId/databases",
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
        .from(databases)
        .where(eq(databases.accountId, accountId))
        .all();

      return rows.map(toPublic);
    },
  );

  // Create a database
  app.post(
    "/api/accounts/:accountId/databases",
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

      const body = request.body as CreateDBBody;
      if (
        !body.engine ||
        !body.name ||
        !body.db_user
      ) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "engine, name, and db_user are required" },
        });
      }

      if (!validEngines.includes(body.engine as typeof validEngines[number])) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "Unsupported engine" },
        });
      }

      if (!isDbIdentifier(body.name) || !isDbIdentifier(body.db_user)) {
        return reply.status(400).send({
          error: {
            code: "INVALID_NAME",
            message: "name and db_user must start with a lowercase letter and use 3-41 lowercase letters, digits or underscores",
          },
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
      if (account.status !== "active") {
        return reply
          .status(409)
          .send({ error: { code: "ACCOUNT_SUSPENDED", message: "Account is suspended" } });
      }

      const dbLimit = checkPlanLimit(accountId, "databases");
      if (!dbLimit) {
        return reply
          .status(500)
          .send({ error: { code: "PLAN_MISSING", message: "Account plan not found" } });
      }
      if (!dbLimit.allowed) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "db.create",
          targetType: "account",
          targetId: String(accountId),
          result: "error",
          errorCode: "PLAN_LIMIT",
        });
        return reply.status(409).send({
          error: {
            code: "PLAN_LIMIT",
            message: `Database limit reached for this plan (${dbLimit.current}/${dbLimit.max})`,
          },
        });
      }

      const password = randomBytes(16).toString("hex");
      const passwordEnc = encryptSecret(password);

      const agentRes = await agent.callAction("db.create", {
        account_slug: account.slug,
        engine: body.engine,
        db_name: body.name,
        db_user: body.db_user,
        db_password: password,
      });

      if (!agentRes.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "db.create",
          targetType: "database",
          result: "error",
          errorCode: agentRes.error?.code ?? "AGENT_ERROR",
        });
        return agentErrorResponse(reply, agentRes);
      }

      const rootPassword = (agentRes.result as { root_password?: string } | undefined)
        ?.root_password;
      const rootPasswordEnc =
        typeof rootPassword === "string" && rootPassword ? encryptSecret(rootPassword) : null;

      const row = db
        .insert(databases)
        .values({
          accountId,
          engine: body.engine as typeof validEngines[number],
          name: body.name,
          dbUser: body.db_user,
          passwordEnc,
          rootPasswordEnc: rootPasswordEnc,
        })
        .returning()
        .get();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "db.create",
        targetType: "database",
        targetId: String(row.id),
        result: "ok",
      });

      return reply.status(201).send({
        ...toPublic(row),
        password,
      });
    },
  );

  // Delete a database
  app.delete(
    "/api/accounts/:accountId/databases/:dbId",
    { preHandler: [requireSession, requireCSRF, requireAccountAccess("accountId")] },
    async (request, reply) => {
      const { accountId: aId, dbId: dId } = request.params as {
        accountId: string;
        dbId: string;
      };
      const accountId = parseId(aId);
      const dbId = parseId(dId);
      if (!accountId || !dbId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid ID" } });
      }

      const db = getDB();
      const row = db
        .select()
        .from(databases)
        .where(and(eq(databases.id, dbId), eq(databases.accountId, accountId)))
        .get();
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Database not found" } });
      }

      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();
      if (!account) {
        return reply
          .status(500)
          .send({ error: { code: "ACCOUNT_MISSING", message: "Account not found" } });
      }

      const [sameEngineCount] = db
        .select({ value: count() })
        .from(databases)
        .where(
          and(
            eq(databases.accountId, accountId),
            eq(databases.engine, row.engine),
          ),
        )
        .all();

      const agentRes = await agent.callAction("db.drop", {
        account_slug: account.slug,
        engine: row.engine,
        db_name: row.name,
        db_user: row.dbUser,
        remaining_dbs: sameEngineCount.value - 1,
      });

      if (!agentRes.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "db.drop",
          targetType: "database",
          targetId: String(dbId),
          result: "error",
          errorCode: agentRes.error?.code ?? "AGENT_ERROR",
        });
        return agentErrorResponse(reply, agentRes);
      }

      db.delete(databases).where(eq(databases.id, dbId)).run();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "db.drop",
        targetType: "database",
        targetId: String(dbId),
        result: "ok",
      });

      return reply.status(204).send();
    },
  );

  // Dump a database
  app.post(
    "/api/accounts/:accountId/databases/:dbId/dump",
    { preHandler: [requireSession, requireCSRF, requireAccountAccess("accountId")] },
    async (request, reply) => {
      const { accountId: aId, dbId: dId } = request.params as {
        accountId: string;
        dbId: string;
      };
      const accountId = parseId(aId);
      const dbId = parseId(dId);
      if (!accountId || !dbId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid ID" } });
      }

      const db = getDB();
      const row = db
        .select()
        .from(databases)
        .where(and(eq(databases.id, dbId), eq(databases.accountId, accountId)))
        .get();
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Database not found" } });
      }

      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();
      if (!account) {
        return reply
          .status(500)
          .send({ error: { code: "ACCOUNT_MISSING", message: "Account not found" } });
      }

      const password = decryptSecret(row.passwordEnc);
      const agentRes = await agent.callAction("db.dump", {
        account_slug: account.slug,
        engine: row.engine,
        db_name: row.name,
        db_user: row.dbUser,
        db_password: password,
      });

      if (!agentRes.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "db.dump",
          targetType: "database",
          targetId: String(dbId),
          result: "error",
          errorCode: agentRes.error?.code ?? "AGENT_ERROR",
        });
        return agentErrorResponse(reply, agentRes);
      }

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "db.dump",
        targetType: "database",
        targetId: String(dbId),
        result: "ok",
      });

      const result = agentRes.result as { path: string };
      const filename = result.path.split("/").pop() ?? result.path;
      return { path: filename };
    },
  );

  // Change password
  app.patch(
    "/api/accounts/:accountId/databases/:dbId/password",
    { preHandler: [requireSession, requireCSRF, requireAccountAccess("accountId")] },
    async (request, reply) => {
      const { accountId: aId, dbId: dId } = request.params as {
        accountId: string;
        dbId: string;
      };
      const accountId = parseId(aId);
      const dbId = parseId(dId);
      if (!accountId || !dbId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid ID" } });
      }

      const db = getDB();
      const row = db
        .select()
        .from(databases)
        .where(and(eq(databases.id, dbId), eq(databases.accountId, accountId)))
        .get();
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Database not found" } });
      }

      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();
      if (!account) {
        return reply
          .status(500)
          .send({ error: { code: "ACCOUNT_MISSING", message: "Account not found" } });
      }

      const newPassword = randomBytes(16).toString("hex");
      const agentRes = await agent.callAction("db.set_password", {
        account_slug: account.slug,
        engine: row.engine,
        db_user: row.dbUser,
        new_password: newPassword,
      });

      if (!agentRes.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "db.set_password",
          targetType: "database",
          targetId: String(dbId),
          result: "error",
          errorCode: agentRes.error?.code ?? "AGENT_ERROR",
        });
        return agentErrorResponse(reply, agentRes);
      }

      const newPasswordEnc = encryptSecret(newPassword);
      db.update(databases)
        .set({ passwordEnc: newPasswordEnc })
        .where(eq(databases.id, dbId))
        .run();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "db.set_password",
        targetType: "database",
        targetId: String(dbId),
        result: "ok",
      });

      return { passwordLast4: newPassword.slice(-4), password: newPassword };
    },
  );

  // Start web tool
  app.post(
    "/api/accounts/:accountId/databases/:dbId/tool/start",
    { preHandler: [requireSession, requireCSRF, requireAccountAccess("accountId")] },
    async (request, reply) => {
      const { accountId: aId, dbId: dId } = request.params as {
        accountId: string;
        dbId: string;
      };
      const accountId = parseId(aId);
      const dbId = parseId(dId);
      if (!accountId || !dbId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid ID" } });
      }

      const body = request.body as ToolStartBody;
      if (
        !body.tool ||
        !validTools.includes(body.tool as typeof validTools[number])
      ) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "Valid tool required (phpmyadmin, adminer, pgadmin)" },
        });
      }

      const db = getDB();
      const row = db
        .select()
        .from(databases)
        .where(and(eq(databases.id, dbId), eq(databases.accountId, accountId)))
        .get();
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Database not found" } });
      }

      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();
      if (!account) {
        return reply
          .status(500)
          .send({ error: { code: "ACCOUNT_MISSING", message: "Account not found" } });
      }

      const dbHost = `fj-${account.slug}-${row.engine}`;
      const agentRes = await agent.callAction("dbtool.start", {
        account_slug: account.slug,
        tool: body.tool,
        engine: row.engine,
        db_host: dbHost,
      });

      if (!agentRes.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "dbtool.start",
          targetType: "database",
          targetId: String(dbId),
          result: "error",
          errorCode: agentRes.error?.code ?? "AGENT_ERROR",
        });
        return agentErrorResponse(reply, agentRes);
      }

      db.update(databases)
        .set({ webTool: body.tool as typeof validTools[number] })
        .where(eq(databases.id, dbId))
        .run();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "dbtool.start",
        targetType: "database",
        targetId: String(dbId),
        result: "ok",
      });

      const result = agentRes.result as { port: number; container_name: string };
      return { port: result.port, containerName: result.container_name };
    },
  );

  // Stop web tool
  app.post(
    "/api/accounts/:accountId/databases/:dbId/tool/stop",
    { preHandler: [requireSession, requireCSRF, requireAccountAccess("accountId")] },
    async (request, reply) => {
      const { accountId: aId, dbId: dId } = request.params as {
        accountId: string;
        dbId: string;
      };
      const accountId = parseId(aId);
      const dbId = parseId(dId);
      if (!accountId || !dbId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid ID" } });
      }

      const db = getDB();
      const row = db
        .select()
        .from(databases)
        .where(and(eq(databases.id, dbId), eq(databases.accountId, accountId)))
        .get();
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Database not found" } });
      }

      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, accountId))
        .get();
      if (!account) {
        return reply
          .status(500)
          .send({ error: { code: "ACCOUNT_MISSING", message: "Account not found" } });
      }

      if (row.webTool === "none") {
        return reply.status(409).send({
          error: { code: "NO_TOOL_RUNNING", message: "No web tool is running" },
        });
      }

      const agentRes = await agent.callAction("dbtool.stop", {
        account_slug: account.slug,
        tool: row.webTool,
      });

      if (!agentRes.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "dbtool.stop",
          targetType: "database",
          targetId: String(dbId),
          result: "error",
          errorCode: agentRes.error?.code ?? "AGENT_ERROR",
        });
        return agentErrorResponse(reply, agentRes);
      }

      db.update(databases)
        .set({ webTool: "none" })
        .where(eq(databases.id, dbId))
        .run();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "dbtool.stop",
        targetType: "database",
        targetId: String(dbId),
        result: "ok",
      });

      return reply.status(204).send();
    },
  );
}
