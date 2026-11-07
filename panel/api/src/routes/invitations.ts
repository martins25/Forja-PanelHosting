import type { FastifyInstance } from "fastify";
import { eq, and, isNull } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { getDB } from "../db/connection.js";
import {
  invitations,
  invitationAccounts,
  users,
  userAccounts,
  accounts,
} from "../db/schema.js";
import {
  requireSession,
  requireCSRF,
  requireAdmin,
} from "../auth/middleware.js";
import { hashPassword } from "../auth/crypto.js";
import { logAudit } from "../audit/log.js";
import { isEmail } from "../validation.js";

const TOKEN_BYTES = 32;
const EXPIRY_HOURS = 72;
const MAX_PASSWORD_LENGTH = 128;

function parseId(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}


interface CreateInvitationBody {
  email: string;
  role: "admin" | "client";
  accountIds?: number[];
}

interface AcceptInvitationBody {
  token: string;
  password: string;
}

export async function invitationRoutes(app: FastifyInstance) {
  app.get(
    "/api/invitations",
    { preHandler: [requireSession, requireAdmin] },
    async () => {
      const db = getDB();
      const rows = db
        .select({
          id: invitations.id,
          email: invitations.email,
          role: invitations.role,
          createdBy: invitations.createdBy,
          expiresAt: invitations.expiresAt,
          acceptedAt: invitations.acceptedAt,
          createdAt: invitations.createdAt,
        })
        .from(invitations)
        .all();

      const allLinks = db.select().from(invitationAccounts).all();

      return rows.map((inv) => ({
        ...inv,
        accountIds: allLinks
          .filter((l) => l.invitationId === inv.id)
          .map((l) => l.accountId),
      }));
    },
  );

  app.post(
    "/api/invitations",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const body = request.body as CreateInvitationBody;

      if (!body.email || !body.role) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "email and role are required" },
        });
      }

      if (typeof body.email !== "string" || typeof body.role !== "string") {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "Invalid types" },
        });
      }

      const email = body.email.trim().toLowerCase();

      if (!isEmail(email)) {
        return reply.status(400).send({
          error: { code: "INVALID_EMAIL", message: "Invalid email format" },
        });
      }

      if (!["admin", "client"].includes(body.role)) {
        return reply.status(400).send({
          error: { code: "INVALID_ROLE", message: "role must be admin or client" },
        });
      }

      if (body.accountIds !== undefined) {
        if (
          !Array.isArray(body.accountIds) ||
          body.accountIds.some((id) => !Number.isInteger(id) || id <= 0)
        ) {
          return reply.status(400).send({
            error: { code: "INVALID_BODY", message: "accountIds must be an array of positive integers" },
          });
        }
      }

      const db = getDB();

      if (body.accountIds && body.accountIds.length > 0) {
        for (const accountId of body.accountIds) {
          const acct = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
          if (!acct) {
            return reply.status(404).send({
              error: { code: "ACCOUNT_NOT_FOUND", message: `Account ${accountId} not found` },
            });
          }
        }
      }

      const existingUser = db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .get();
      if (existingUser) {
        return reply.status(409).send({
          error: { code: "USER_EXISTS", message: "A user with this email already exists" },
        });
      }

      const pending = db
        .select()
        .from(invitations)
        .where(
          and(
            eq(invitations.email, email),
            isNull(invitations.acceptedAt),
          ),
        )
        .get();
      if (pending) {
        return reply.status(409).send({
          error: { code: "INVITATION_EXISTS", message: "A pending invitation for this email already exists" },
        });
      }

      const token = randomBytes(TOKEN_BYTES).toString("hex");
      const tokenHash = hashToken(token);
      const expiresAt = new Date(
        Date.now() + EXPIRY_HOURS * 60 * 60 * 1000,
      ).toISOString();

      const row = db
        .insert(invitations)
        .values({
          email,
          role: body.role,
          token: tokenHash,
          createdBy: request.session!.user.id,
          expiresAt,
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get();

      if (body.accountIds && body.accountIds.length > 0) {
        for (const accountId of body.accountIds) {
          db.insert(invitationAccounts)
            .values({ invitationId: row.id, accountId })
            .run();
        }
      }

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "invitation.create",
        targetType: "invitation",
        targetId: String(row.id),
        result: "ok",
      });

      return reply.status(201).send({
        id: row.id,
        email: row.email,
        role: row.role,
        token,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
      });
    },
  );

  app.delete(
    "/api/invitations/:id",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const id = parseId((request.params as { id: string }).id);
      if (!id) {
        return reply.status(400).send({
          error: { code: "INVALID_ID", message: "Invalid invitation ID" },
        });
      }

      const db = getDB();
      const existing = db
        .select()
        .from(invitations)
        .where(eq(invitations.id, id))
        .get();
      if (!existing) {
        return reply.status(404).send({
          error: { code: "NOT_FOUND", message: "Invitation not found" },
        });
      }

      if (existing.acceptedAt) {
        return reply.status(409).send({
          error: { code: "ALREADY_ACCEPTED", message: "Invitation already accepted" },
        });
      }

      db.delete(invitationAccounts)
        .where(eq(invitationAccounts.invitationId, id))
        .run();
      db.delete(invitations).where(eq(invitations.id, id)).run();

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "invitation.cancel",
        targetType: "invitation",
        targetId: String(id),
        result: "ok",
      });

      return reply.status(204).send();
    },
  );

  app.post("/api/auth/accept-invitation", async (request, reply) => {
    const body = request.body as AcceptInvitationBody;

    if (!body.token || !body.password) {
      return reply.status(400).send({
        error: { code: "INVALID_BODY", message: "token and password are required" },
      });
    }

    if (typeof body.password !== "string" || body.password.length < 8 || body.password.length > MAX_PASSWORD_LENGTH) {
      return reply.status(400).send({
        error: { code: "WEAK_PASSWORD", message: "Password must be between 8 and 128 characters" },
      });
    }

    if (typeof body.token !== "string" || !/^[0-9a-f]{64}$/.test(body.token)) {
      return reply.status(400).send({
        error: { code: "INVALID_TOKEN", message: "Invalid token format" },
      });
    }

    const db = getDB();
    const tokenHash = hashToken(body.token);
    const invitation = db
      .select()
      .from(invitations)
      .where(eq(invitations.token, tokenHash))
      .get();

    if (!invitation) {
      return reply.status(404).send({
        error: { code: "NOT_FOUND", message: "Invitation not found" },
      });
    }

    if (invitation.acceptedAt) {
      return reply.status(409).send({
        error: { code: "ALREADY_ACCEPTED", message: "Invitation already accepted" },
      });
    }

    if (new Date(invitation.expiresAt) < new Date()) {
      return reply.status(410).send({
        error: { code: "EXPIRED", message: "Invitation has expired" },
      });
    }

    const existingUser = db
      .select()
      .from(users)
      .where(eq(users.email, invitation.email))
      .get();
    if (existingUser) {
      return reply.status(409).send({
        error: { code: "USER_EXISTS", message: "A user with this email already exists" },
      });
    }

    const passwordHash = await hashPassword(body.password);

    const user = db.transaction((tx) => {
      const updated = tx
        .update(invitations)
        .set({ acceptedAt: new Date().toISOString() })
        .where(and(eq(invitations.id, invitation.id), isNull(invitations.acceptedAt)))
        .returning()
        .get();

      if (!updated) {
        throw new Error("RACE_LOST");
      }

      const u = tx
        .insert(users)
        .values({
          email: invitation.email,
          role: invitation.role,
          passwordHash,
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get();

      const accountLinks = tx
        .select()
        .from(invitationAccounts)
        .where(eq(invitationAccounts.invitationId, invitation.id))
        .all();

      for (const link of accountLinks) {
        tx.insert(userAccounts)
          .values({ userId: u.id, accountId: link.accountId })
          .run();
      }

      return { id: u.id, email: u.email, role: u.role };
    });

    logAudit({
      actorUserId: user.id,
      actorKind: "user",
      action: "invitation.accept",
      targetType: "invitation",
      targetId: String(invitation.id),
      result: "ok",
    });

    return reply.status(201).send(user);
  });
}
