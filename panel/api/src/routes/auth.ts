import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { getDB } from "../db/connection.js";
import { users } from "../db/schema.js";
import { verifyPassword, hashPassword, signTotpToken, verifyTotpToken } from "../auth/crypto.js";
import { verifyCode, generateSecret, generateURI, encryptSecret, decryptSecret } from "../auth/totp.js";
import {
  createSession,
  deleteSession,
  buildSessionCookie,
  buildClearCookie,
} from "../auth/session.js";
import {
  requireAccess,
  requireSession,
  requireCSRF,
} from "../auth/middleware.js";

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: { password: string } }>(
    "/api/auth/login",
    {
      preHandler: [requireAccess],
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { password } = request.body ?? {};
      if (!password || typeof password !== "string") {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "Password required" } });
      }

      const email = request.accessClaims!.email;
      const db = getDB();
      const user = db
        .select()
        .from(users)
        .where(eq(users.email, email))
        .get();

      if (!user) {
        await hashPassword("dummy");
        return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } });
      }

      if (user.disabled) {
        await hashPassword("dummy");
        return reply.code(401).send({ error: { code: "ACCOUNT_DISABLED", message: "Account disabled" } });
      }

      const valid = await verifyPassword(user.passwordHash, password);
      if (!valid) {
        return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } });
      }

      if (user.totpSecretEnc) {
        const tempToken = signTotpToken(user.id, email);

        return reply.send({ status: "totp_required", totpToken: tempToken });
      }

      const ip = request.ip;
      const ua = (request.headers["user-agent"] as string) ?? "";
      const { sessionId, csrfToken } = await createSession(user.id, ip, ua);

      db.update(users)
        .set({ lastLoginAt: new Date().toISOString() })
        .where(eq(users.id, user.id))
        .run();

      reply.header("Set-Cookie", buildSessionCookie(sessionId));
      return reply.send({
        status: "ok",
        user: { id: user.id, email: user.email, role: user.role },
        csrfToken,
      });
    },
  );

  app.post<{ Body: { code: string; totpToken: string } }>(
    "/api/auth/login/totp",
    {
      preHandler: [requireAccess],
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const { code, totpToken } = request.body ?? {};
      if (!code || !totpToken) {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "Code and totpToken required" } });
      }

      const verified = verifyTotpToken(totpToken, request.accessClaims!.email);
      if (!verified.ok) {
        if (verified.reason === "expired") {
          return reply.code(401).send({ error: { code: "TOKEN_EXPIRED", message: "TOTP token expired" } });
        }
        return reply.code(400).send({ error: { code: "INVALID_TOKEN", message: "Invalid TOTP token" } });
      }

      const db = getDB();
      const user = db
        .select()
        .from(users)
        .where(eq(users.id, verified.userId))
        .get();

      if (!user || !user.totpSecretEnc || user.disabled) {
        return reply.code(401).send({ error: { code: "INVALID_CREDENTIALS", message: "Invalid credentials" } });
      }

      const secret = decryptSecret(user.totpSecretEnc);
      if (!verifyCode(secret, code)) {
        return reply.code(401).send({ error: { code: "INVALID_TOTP", message: "Invalid TOTP code" } });
      }

      const ip = request.ip;
      const ua = (request.headers["user-agent"] as string) ?? "";
      const { sessionId, csrfToken } = await createSession(user.id, ip, ua);

      db.update(users)
        .set({ lastLoginAt: new Date().toISOString() })
        .where(eq(users.id, user.id))
        .run();

      reply.header("Set-Cookie", buildSessionCookie(sessionId));
      return reply.send({
        status: "ok",
        user: { id: user.id, email: user.email, role: user.role },
        csrfToken,
      });
    },
  );

  app.get(
    "/api/auth/me",
    { preHandler: [requireSession] },
    async (request) => ({
      user: request.session!.user,
      csrfToken: request.session!.csrfToken,
    }),
  );

  app.post(
    "/api/auth/logout",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      await deleteSession(request.session!.id);
      reply.header("Set-Cookie", buildClearCookie());
      return reply.send({ ok: true });
    },
  );

  app.post(
    "/api/auth/totp/setup",
    { preHandler: [requireSession, requireCSRF] },
    async (request) => {
      const user = request.session!.user;
      if (user.hasTOTP) {
        return { error: { code: "TOTP_ALREADY_ENABLED", message: "TOTP already configured" } };
      }

      const secret = generateSecret();
      const uri = generateURI(user.email, secret);
      return { secret, uri };
    },
  );

  app.post<{ Body: { code: string; secret: string } }>(
    "/api/auth/totp/enable",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      const { code, secret } = request.body ?? {};
      if (!code || !secret) {
        return reply.code(400).send({ error: { code: "BAD_REQUEST", message: "Code and secret required" } });
      }

      if (!verifyCode(secret, code)) {
        return reply.code(400).send({ error: { code: "INVALID_TOTP", message: "Invalid TOTP code" } });
      }

      const db = getDB();
      const encrypted = encryptSecret(secret);
      db.update(users)
        .set({ totpSecretEnc: encrypted })
        .where(eq(users.id, request.session!.user.id))
        .run();

      return { ok: true };
    },
  );
}
