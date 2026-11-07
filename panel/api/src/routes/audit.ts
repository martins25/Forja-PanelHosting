import type { FastifyInstance } from "fastify";
import { getDB } from "../db/connection.js";
import { auditLog, users } from "../db/schema.js";
import { eq, desc, and, gte, lte, sql } from "drizzle-orm";
import { requireSession } from "../auth/middleware.js";

export async function auditRoutes(app: FastifyInstance) {
  app.get(
    "/api/audit",
    { preHandler: [requireSession] },
    async (request, reply) => {
      const query = request.query as {
        page?: string;
        limit?: string;
        action?: string;
        targetType?: string;
        actorUserId?: string;
        since?: string;
        until?: string;
      };

      // Repeated or bracketed parameters arrive as arrays; filters are scalars.
      if (Object.values(query).some((v) => typeof v !== "string")) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_QUERY", message: "Query parameters must be single values" } });
      }

      const page = Math.max(Number(query.page) || 1, 1);
      const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100);
      const offset = (page - 1) * limit;

      const conditions = [];

      if (request.session!.user.role !== "admin") {
        conditions.push(eq(auditLog.actorUserId, request.session!.user.id));
      }

      if (query.action) {
        conditions.push(eq(auditLog.action, query.action));
      }
      if (query.targetType) {
        conditions.push(eq(auditLog.targetType, query.targetType));
      }
      if (query.actorUserId) {
        const uid = Number(query.actorUserId);
        if (!Number.isNaN(uid)) {
          conditions.push(eq(auditLog.actorUserId, uid));
        }
      }
      if (query.since) {
        conditions.push(gte(auditLog.at, query.since));
      }
      if (query.until) {
        conditions.push(lte(auditLog.at, query.until));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const db = getDB();

      const rows = db
        .select({
          id: auditLog.id,
          at: auditLog.at,
          actorUserId: auditLog.actorUserId,
          actorKind: auditLog.actorKind,
          actorEmail: users.email,
          action: auditLog.action,
          targetType: auditLog.targetType,
          targetId: auditLog.targetId,
          result: auditLog.result,
          errorCode: auditLog.errorCode,
        })
        .from(auditLog)
        .leftJoin(users, eq(auditLog.actorUserId, users.id))
        .where(where)
        .orderBy(desc(auditLog.id))
        .limit(limit)
        .offset(offset)
        .all();

      const [{ total }] = db
        .select({ total: sql<number>`count(*)` })
        .from(auditLog)
        .where(where)
        .all();

      return reply.send({
        data: rows,
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      });
    },
  );
}
