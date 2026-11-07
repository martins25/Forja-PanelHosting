import type { FastifyInstance } from "fastify";
import type { AgentClient } from "../agent/client.js";
import { getDB } from "../db/connection.js";
import { accounts, plans } from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import {
  requireSession,
  requireCSRF,
  requireAdmin,
  getAccessibleAccountIds,
} from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";
import { loadAccountPlan, countResource } from "../plans/limits.js";
import { agentErrorResponse } from "../agent/errors.js";
import { isSlug } from "../validation.js";

interface AccountsOpts {
  agentClient: AgentClient;
}

export async function accountRoutes(
  app: FastifyInstance,
  opts: AccountsOpts,
) {
  const agent = opts.agentClient;

  app.get(
    "/api/accounts",
    { preHandler: [requireSession, requireAdmin] },
    async () => {
      const db = getDB();
      return db.select().from(accounts).all();
    },
  );

  // Accounts visible to the current user: all for admins, only the assigned
  // ones for clients. Exposes just what the UI needs (no plan, uid or linux user).
  app.get(
    "/api/me/accounts",
    { preHandler: [requireSession] },
    async (request) => {
      const db = getDB();
      const { id, role } = request.session!.user;
      const ids = getAccessibleAccountIds(id, role);
      const rows = ids
        ? ids.length === 0
          ? []
          : db.select().from(accounts).where(inArray(accounts.id, ids)).all()
        : db.select().from(accounts).all();
      return rows.map((a) => ({ id: a.id, slug: a.slug, status: a.status }));
    },
  );

  // Plan usage vs limits for one account. Visible to admins and to clients
  // assigned to the account.
  app.get(
    "/api/accounts/:accountId/usage",
    { preHandler: [requireSession] },
    async (request, reply) => {
      const { accountId: rawId } = request.params as { accountId: string };
      const accountId = Number(rawId);
      if (!Number.isInteger(accountId) || accountId <= 0) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid account ID" } });
      }

      const { id: userId, role } = request.session!.user;
      const accessible = getAccessibleAccountIds(userId, role);
      if (accessible && !accessible.includes(accountId)) {
        return reply
          .status(403)
          .send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
      }

      const loaded = loadAccountPlan(accountId);
      if (!loaded) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Account or plan not found" } });
      }

      const { plan } = loaded;
      return {
        sites: { current: countResource(accountId, "sites"), max: plan.maxSites },
        databases: { current: countResource(accountId, "databases"), max: plan.maxDatabases },
        cpu: plan.cpuMillis,
        memory: plan.memoryMb,
      };
    },
  );

  app.get(
    "/api/accounts/:id",
    { preHandler: [requireSession, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const accountId = Number(id);
      if (Number.isNaN(accountId)) {
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
          .send({ error: { code: "NOT_FOUND", message: "Account not found" } });
      }

      return account;
    },
  );

  app.post(
    "/api/accounts",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const body = request.body as { slug?: string; planId?: number };

      if (!body.slug || typeof body.slug !== "string") {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_BODY", message: "slug is required" } });
      }

      if (!body.planId || typeof body.planId !== "number") {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_BODY", message: "planId is required" } });
      }

      if (!isSlug(body.slug)) {
        return reply.status(400).send({
          error: {
            code: "INVALID_SLUG",
            message: "slug must start with a letter and use 3-31 lowercase letters, digits or hyphens",
          },
        });
      }

      const slug = body.slug;
      const planId = body.planId;

      const db = getDB();

      const plan = db.select().from(plans).where(eq(plans.id, planId)).get();
      if (!plan) {
        return reply
          .status(404)
          .send({ error: { code: "PLAN_NOT_FOUND", message: "Plan not found" } });
      }

      const existing = db
        .select()
        .from(accounts)
        .where(eq(accounts.slug, slug))
        .get();
      if (existing) {
        return reply
          .status(409)
          .send({ error: { code: "DUPLICATE", message: "Account slug already exists" } });
      }

      const agentRes = await agent.callAction<{
        linux_user: string;
        uid: number;
        home_dir: string;
      }>("account.create", {
        slug,
        cpu_millis: plan.cpuMillis,
        memory_mb: plan.memoryMb,
        disk_mb: plan.diskMb,
      });

      if (!agentRes.ok || !agentRes.result) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "account.create",
          targetType: "account",
          result: "error",
          errorCode: agentRes.error?.code ?? "AGENT_ERROR",
        });
        return agentErrorResponse(reply, agentRes);
      }

      const result = db
        .insert(accounts)
        .values({
          slug,
          linuxUser: agentRes.result.linux_user,
          uid: agentRes.result.uid,
          planId,
          status: "active",
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "account.create",
        targetType: "account",
        targetId: String(result.id),
        result: "ok",
      });

      return reply.status(201).send(result);
    },
  );

  app.post(
    "/api/accounts/:id/suspend",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const accountId = Number(id);
      if (Number.isNaN(accountId)) {
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
          .send({ error: { code: "NOT_FOUND", message: "Account not found" } });
      }

      if (account.status === "suspended") {
        return reply
          .status(409)
          .send({ error: { code: "ALREADY_SUSPENDED", message: "Account is already suspended" } });
      }

      const result = db
        .update(accounts)
        .set({ status: "suspended" })
        .where(eq(accounts.id, accountId))
        .returning()
        .get();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "account.suspend",
        targetType: "account",
        targetId: String(accountId),
        result: "ok",
      });

      return result;
    },
  );

  app.post(
    "/api/accounts/:id/resume",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const accountId = Number(id);
      if (Number.isNaN(accountId)) {
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
          .send({ error: { code: "NOT_FOUND", message: "Account not found" } });
      }

      if (account.status === "active") {
        return reply
          .status(409)
          .send({ error: { code: "ALREADY_ACTIVE", message: "Account is already active" } });
      }

      const result = db
        .update(accounts)
        .set({ status: "active" })
        .where(eq(accounts.id, accountId))
        .returning()
        .get();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "account.resume",
        targetType: "account",
        targetId: String(accountId),
        result: "ok",
      });

      return result;
    },
  );
}
