import type { FastifyInstance } from "fastify";
import { getDB } from "../db/connection.js";
import { plans, accounts } from "../db/schema.js";
import { eq, count } from "drizzle-orm";
import {
  requireSession,
  requireCSRF,
  requireAdmin,
} from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";

interface PlanBody {
  name: string;
  cpuMillis: number;
  memoryMb: number;
  diskMb: number;
  maxSites: number;
  maxDatabases: number;
}

function validatePlanBody(body: unknown): PlanBody {
  const b = body as Record<string, unknown>;
  if (!b || typeof b !== "object") throw new Error("invalid body");

  const name = b.name;
  if (typeof name !== "string" || name.length < 1 || name.length > 50) {
    throw new Error("name must be 1-50 characters");
  }

  const cpuMillis = b.cpuMillis;
  if (typeof cpuMillis !== "number" || cpuMillis < 100 || cpuMillis > 16000) {
    throw new Error("cpuMillis must be 100-16000");
  }

  const memoryMb = b.memoryMb;
  if (typeof memoryMb !== "number" || memoryMb < 64 || memoryMb > 65536) {
    throw new Error("memoryMb must be 64-65536");
  }

  const diskMb = b.diskMb;
  if (typeof diskMb !== "number" || diskMb < 100 || diskMb > 1048576) {
    throw new Error("diskMb must be 100-1048576");
  }

  const maxSites = b.maxSites;
  if (typeof maxSites !== "number" || maxSites < 1 || maxSites > 1000) {
    throw new Error("maxSites must be 1-1000");
  }

  const maxDatabases = b.maxDatabases;
  if (
    typeof maxDatabases !== "number" ||
    maxDatabases < 0 ||
    maxDatabases > 1000
  ) {
    throw new Error("maxDatabases must be 0-1000");
  }

  return {
    name: name as string,
    cpuMillis: cpuMillis as number,
    memoryMb: memoryMb as number,
    diskMb: diskMb as number,
    maxSites: maxSites as number,
    maxDatabases: maxDatabases as number,
  };
}

export async function planRoutes(app: FastifyInstance) {
  app.get(
    "/api/plans",
    { preHandler: [requireSession, requireAdmin] },
    async () => {
      const db = getDB();
      return db.select().from(plans).all();
    },
  );

  app.post(
    "/api/plans",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      let body: PlanBody;
      try {
        body = validatePlanBody(request.body);
      } catch (e) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_BODY", message: (e as Error).message } });
      }

      const db = getDB();

      const existing = db
        .select()
        .from(plans)
        .where(eq(plans.name, body.name))
        .get();
      if (existing) {
        return reply
          .status(409)
          .send({ error: { code: "DUPLICATE", message: "Plan name already exists" } });
      }

      const result = db.insert(plans).values(body).returning().get();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "plan.create",
        targetType: "plan",
        targetId: String(result.id),
        result: "ok",
      });

      return reply.status(201).send(result);
    },
  );

  app.put(
    "/api/plans/:id",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const planId = Number(id);
      if (Number.isNaN(planId)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid plan ID" } });
      }

      let body: PlanBody;
      try {
        body = validatePlanBody(request.body);
      } catch (e) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_BODY", message: (e as Error).message } });
      }

      const db = getDB();

      const existing = db
        .select()
        .from(plans)
        .where(eq(plans.id, planId))
        .get();
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Plan not found" } });
      }

      const duplicate = db
        .select()
        .from(plans)
        .where(eq(plans.name, body.name))
        .get();
      if (duplicate && duplicate.id !== planId) {
        return reply
          .status(409)
          .send({ error: { code: "DUPLICATE", message: "Plan name already exists" } });
      }

      const result = db
        .update(plans)
        .set(body)
        .where(eq(plans.id, planId))
        .returning()
        .get();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "plan.update",
        targetType: "plan",
        targetId: String(planId),
        result: "ok",
      });

      return result;
    },
  );

  app.delete(
    "/api/plans/:id",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const planId = Number(id);
      if (Number.isNaN(planId)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid plan ID" } });
      }

      const db = getDB();

      const existing = db
        .select()
        .from(plans)
        .where(eq(plans.id, planId))
        .get();
      if (!existing) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Plan not found" } });
      }

      const [accountCount] = db
        .select({ value: count() })
        .from(accounts)
        .where(eq(accounts.planId, planId))
        .all();
      if (accountCount.value > 0) {
        return reply.status(409).send({
          error: {
            code: "HAS_ACCOUNTS",
            message: "Cannot delete plan with associated accounts",
          },
        });
      }

      db.delete(plans).where(eq(plans.id, planId)).run();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "plan.delete",
        targetType: "plan",
        targetId: String(planId),
        result: "ok",
      });

      return reply.status(204).send();
    },
  );
}
