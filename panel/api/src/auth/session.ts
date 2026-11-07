import { randomUUID, randomBytes, createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDB } from "../db/connection.js";
import { sessions, users } from "../db/schema.js";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const COOKIE_NAME = "forja_session";

export interface SessionUser {
  id: number;
  email: string;
  role: "admin" | "client";
  hasTOTP: boolean;
}

export interface SessionData {
  id: string;
  csrfToken: string;
  user: SessionUser;
}

function hashIP(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

export async function createSession(
  userId: number,
  ip: string,
  userAgent: string,
): Promise<{ sessionId: string; csrfToken: string }> {
  const db = getDB();
  const sessionId = randomUUID();
  const csrfToken = randomBytes(32).toString("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  db.insert(sessions)
    .values({
      id: sessionId,
      userId,
      csrfToken,
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      ipHash: hashIP(ip),
      userAgent: userAgent.slice(0, 256),
    })
    .run();

  return { sessionId, csrfToken };
}

export async function getSession(sessionId: string): Promise<SessionData | null> {
  const db = getDB();
  const row = db
    .select({
      id: sessions.id,
      csrfToken: sessions.csrfToken,
      expiresAt: sessions.expiresAt,
      userId: users.id,
      email: users.email,
      role: users.role,
      totpSecretEnc: users.totpSecretEnc,
      disabled: users.disabled,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(eq(sessions.id, sessionId))
    .get();

  if (!row) return null;

  if (new Date(row.expiresAt) <= new Date()) {
    await deleteSession(sessionId);
    return null;
  }

  if (row.disabled) return null;

  return {
    id: row.id,
    csrfToken: row.csrfToken,
    user: {
      id: row.userId,
      email: row.email,
      role: row.role as "admin" | "client",
      hasTOTP: !!row.totpSecretEnc,
    },
  };
}

export async function deleteSession(sessionId: string): Promise<void> {
  const db = getDB();
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

export async function deleteUserSessions(userId: number): Promise<void> {
  const db = getDB();
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}

export function getSessionCookieName(): string {
  return COOKIE_NAME;
}

export function buildSessionCookie(
  sessionId: string,
  secure: boolean = true,
): string {
  const maxAge = SESSION_TTL_MS / 1000;
  const parts = [
    `${COOKIE_NAME}=${sessionId}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Strict`,
    `Max-Age=${maxAge}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function buildClearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}
