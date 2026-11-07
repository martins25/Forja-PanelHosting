import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { getDB } from "../db/connection.js";
import { users, userAccounts, accounts, sessions } from "../db/schema.js";
import {
  requireSession,
  requireCSRF,
  requireAdmin,
} from "../auth/middleware.js";
import { hashPassword } from "../auth/crypto.js";
import { logAudit } from "../audit/log.js";
import { isEmail } from "../validation.js";

function parseId(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const MAX_PASSWORD_LENGTH = 128;

interface CreateUserBody {
  email: string;
  password: string;
  role: "admin" | "client";
}

interface UpdateUserBody {
  role?: "admin" | "client";
  disabled?: boolean;
}

interface AssignAccountBody {
  accountId: number;
}

export async function userRoutes(app: FastifyInstance) {
  app.get(
    "/api/users",
    { preHandler: [requireSession, requireAdmin] },
    async () => {
      const db = getDB();
      const rows = db
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
          disabled: users.disabled,
          createdAt: users.createdAt,
          lastLoginAt: users.lastLoginAt,
        })
        .from(users)
        .all();

      const allLinks = db.select().from(userAccounts).all();

      return rows.map((u) => ({
        ...u,
        accounts: allLinks
          .filter((l) => l.userId === u.id)
          .map((l) => l.accountId),
      }));
    },
  );

  app.post(
    "/api/users",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const body = request.body as CreateUserBody;

      if (!body.email || !body.password || !body.role) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "email, password, and role are required" },
        });
      }

      if (typeof body.email !== "string" || typeof body.password !== "string") {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "Invalid types" },
        });
      }

      body.email = body.email.trim().toLowerCase();

      if (!isEmail(body.email)) {
        return reply.status(400).send({
          error: { code: "INVALID_EMAIL", message: "Invalid email format" },
        });
      }

      if (body.password.length < 8 || body.password.length > MAX_PASSWORD_LENGTH) {
        return reply.status(400).send({
          error: { code: "WEAK_PASSWORD", message: "Password must be between 8 and 128 characters" },
        });
      }

      if (!["admin", "client"].includes(body.role)) {
        return reply.status(400).send({
          error: { code: "INVALID_ROLE", message: "role must be admin or client" },
        });
      }

      const db = getDB();
      const existing = db
        .select()
        .from(users)
        .where(eq(users.email, body.email))
        .get();
      if (existing) {
        return reply.status(409).send({
          error: { code: "DUPLICATE_EMAIL", message: "Email already in use" },
        });
      }

      const passwordHash = await hashPassword(body.password);
      const row = db
        .insert(users)
        .values({
          email: body.email,
          role: body.role,
          passwordHash,
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "user.create",
        targetType: "user",
        targetId: String(row.id),
        result: "ok",
      });

      return reply.status(201).send({
        id: row.id,
        email: row.email,
        role: row.role,
        disabled: row.disabled,
        createdAt: row.createdAt,
      });
    },
  );

  app.patch(
    "/api/users/:id",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const id = parseId((request.params as { id: string }).id);
      if (!id) {
        return reply.status(400).send({
          error: { code: "INVALID_ID", message: "Invalid user ID" },
        });
      }

      const body = request.body as UpdateUserBody;

      if (body.role !== undefined && !["admin", "client"].includes(body.role)) {
        return reply.status(400).send({
          error: { code: "INVALID_ROLE", message: "role must be admin or client" },
        });
      }

      if (id === request.session!.user.id && body.role === "client") {
        return reply.status(409).send({
          error: { code: "SELF_DEMOTE", message: "Cannot demote yourself" },
        });
      }

      if (id === request.session!.user.id && body.disabled === true) {
        return reply.status(409).send({
          error: { code: "SELF_DISABLE", message: "Cannot disable yourself" },
        });
      }

      const db = getDB();
      const existing = db.select().from(users).where(eq(users.id, id)).get();
      if (!existing) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "User not found" },
        });
      }

      const updates: Record<string, unknown> = {};
      if (body.role !== undefined) updates.role = body.role;
      if (body.disabled !== undefined) updates.disabled = body.disabled;

      if (Object.keys(updates).length === 0) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "Nothing to update" },
        });
      }

      db.update(users).set(updates).where(eq(users.id, id)).run();

      if (body.disabled === true) {
        db.delete(sessions).where(eq(sessions.userId, id)).run();
      }

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "user.update",
        targetType: "user",
        targetId: String(id),
        result: "ok",
      });

      const updated = db
        .select({
          id: users.id,
          email: users.email,
          role: users.role,
          disabled: users.disabled,
          createdAt: users.createdAt,
          lastLoginAt: users.lastLoginAt,
        })
        .from(users)
        .where(eq(users.id, id))
        .get();

      return updated;
    },
  );

  app.delete(
    "/api/users/:id",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const id = parseId((request.params as { id: string }).id);
      if (!id) {
        return reply.status(400).send({
          error: { code: "INVALID_ID", message: "Invalid user ID" },
        });
      }

      if (id === request.session!.user.id) {
        return reply.status(409).send({
          error: { code: "SELF_DELETE", message: "Cannot delete yourself" },
        });
      }

      const db = getDB();
      const existing = db.select().from(users).where(eq(users.id, id)).get();
      if (!existing) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "User not found" },
        });
      }

      db.transaction((tx) => {
        tx.delete(sessions).where(eq(sessions.userId, id)).run();
        tx.delete(userAccounts).where(eq(userAccounts.userId, id)).run();
        tx.delete(users).where(eq(users.id, id)).run();
      });

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "user.delete",
        targetType: "user",
        targetId: String(id),
        result: "ok",
      });

      return reply.status(204).send();
    },
  );

  app.post(
    "/api/users/:id/accounts",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const id = parseId((request.params as { id: string }).id);
      if (!id) {
        return reply.status(400).send({
          error: { code: "INVALID_ID", message: "Invalid user ID" },
        });
      }

      const body = request.body as AssignAccountBody;
      if (!body.accountId || !Number.isInteger(body.accountId)) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "accountId is required" },
        });
      }

      const db = getDB();
      const user = db.select().from(users).where(eq(users.id, id)).get();
      if (!user) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "User not found" },
        });
      }

      const account = db
        .select()
        .from(accounts)
        .where(eq(accounts.id, body.accountId))
        .get();
      if (!account) {
        return reply.status(404).send({
          error: { code: "ACCOUNT_NOT_FOUND", message: "Account not found" },
        });
      }

      const existing = db
        .select()
        .from(userAccounts)
        .where(
          and(
            eq(userAccounts.userId, id),
            eq(userAccounts.accountId, body.accountId),
          ),
        )
        .get();
      if (existing) {
        return reply.status(409).send({
          error: { code: "ALREADY_ASSIGNED", message: "Account already assigned to user" },
        });
      }

      db.insert(userAccounts)
        .values({ userId: id, accountId: body.accountId })
        .run();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "user.assign_account",
        targetType: "user",
        targetId: String(id),
        result: "ok",
      });

      return reply.status(201).send({ userId: id, accountId: body.accountId });
    },
  );

  app.delete(
    "/api/users/:id/accounts/:accountId",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const params = request.params as { id: string; accountId: string };
      const id = parseId(params.id);
      const accountId = parseId(params.accountId);
      if (!id || !accountId) {
        return reply.status(400).send({
          error: { code: "INVALID_ID", message: "Invalid ID" },
        });
      }

      const db = getDB();
      const link = db
        .select()
        .from(userAccounts)
        .where(
          and(
            eq(userAccounts.userId, id),
            eq(userAccounts.accountId, accountId),
          ),
        )
        .get();
      if (!link) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "Assignment not found" },
        });
      }

      db.delete(userAccounts)
        .where(
          and(
            eq(userAccounts.userId, id),
            eq(userAccounts.accountId, accountId),
          ),
        )
        .run();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "user.unassign_account",
        targetType: "user",
        targetId: String(id),
        result: "ok",
      });

      return reply.status(204).send();
    },
  );
}
