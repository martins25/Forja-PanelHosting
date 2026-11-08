import type { FastifyRequest, FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { verifyAccessJWT, isAccessConfigured, type AccessClaims } from "./access.js";
import {
  getSession,
  getSessionCookieName,
  type SessionData,
} from "./session.js";
import { getDB } from "../db/connection.js";
import { userAccounts } from "../db/schema.js";

declare module "fastify" {
  interface FastifyRequest {
    accessClaims?: AccessClaims;
    session?: SessionData;
  }
}

export async function requireAccess(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const token = request.headers["cf-access-jwt-assertion"] as string | undefined;

  if (token) {
    try {
      request.accessClaims = await verifyAccessJWT(token);
    } catch {
      reply.code(401).send({ error: { code: "INVALID_ACCESS_TOKEN", message: "Invalid Cloudflare Access token" } });
    }
    return;
  }

  if (!isAccessConfigured()) return;

  reply.code(401).send({ error: { code: "NO_ACCESS_TOKEN", message: "Missing Cloudflare Access token" } });
}

export async function requireSession(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const cookieName = getSessionCookieName();
  const sessionId = request.cookies?.[cookieName];
  if (!sessionId) {
    reply.code(401).send({ error: { code: "NO_SESSION", message: "Authentication required" } });
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    reply.code(401).send({ error: { code: "INVALID_SESSION", message: "Session expired or invalid" } });
    return;
  }

  request.session = session;
}

export async function requireCSRF(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.session) {
    reply.code(401).send({ error: { code: "NO_SESSION", message: "Authentication required" } });
    return;
  }

  const header = request.headers["x-csrf-token"] as string | undefined;
  if (!header) {
    reply.code(403).send({ error: { code: "MISSING_CSRF", message: "CSRF token required" } });
    return;
  }

  const expected = Buffer.from(request.session.csrfToken, "utf8");
  const received = Buffer.from(header, "utf8");

  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    reply.code(403).send({ error: { code: "INVALID_CSRF", message: "Invalid CSRF token" } });
    return;
  }
}

export async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (!request.session) {
    reply.code(401).send({ error: { code: "NO_SESSION", message: "Authentication required" } });
    return;
  }

  if (request.session.user.role !== "admin") {
    reply.code(403).send({ error: { code: "FORBIDDEN", message: "Admin access required" } });
    return;
  }
}

export function requireAccountAccess(paramName = "accountId") {
  return async function (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    if (!request.session) {
      reply.code(401).send({ error: { code: "NO_SESSION", message: "Authentication required" } });
      return;
    }

    if (request.session.user.role === "admin") return;

    const raw = (request.params as Record<string, string>)[paramName];
    const accountId = Number(raw);
    if (Number.isNaN(accountId)) {
      reply.code(400).send({ error: { code: "INVALID_ID", message: "Invalid account ID" } });
      return;
    }

    const db = getDB();
    const link = db
      .select()
      .from(userAccounts)
      .where(
        and(
          eq(userAccounts.userId, request.session.user.id),
          eq(userAccounts.accountId, accountId),
        ),
      )
      .get();

    if (!link) {
      reply.code(403).send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
      return;
    }
  };
}

export function getAccessibleAccountIds(userId: number, role: string): number[] | null {
  if (role === "admin") return null;
  const db = getDB();
  const rows = db
    .select({ accountId: userAccounts.accountId })
    .from(userAccounts)
    .where(eq(userAccounts.userId, userId))
    .all();
  return rows.map((r) => r.accountId);
}
