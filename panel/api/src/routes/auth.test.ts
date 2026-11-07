import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { buildApp } from "../app.js";
import {
  setAppKeyForTest,
  clearAppKey,
  hashPassword,
  signTotpToken,
} from "../auth/crypto.js";
import {
  configureAccess,
  resetAccess,
  setVerifierForTest,
  clearVerifierForTest,
} from "../auth/access.js";
import { encryptSecret } from "../auth/totp.js";
import { TOTP } from "otpauth";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

let sqlite: InstanceType<typeof Database>;

describe("auth routes", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    setAppKeyForTest(randomBytes(32));
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    vi.mocked(getDB).mockReturnValue(db);

    configureAccess({
      teamDomain: "test.cloudflareaccess.com",
      audience: "test-aud",
    });

    setVerifierForTest(async () => ({
      email: "admin@forja.dev",
      sub: "u1",
    }));

    const hash = await hashPassword("correct-password");
    db.insert(schema.users)
      .values({
        email: "admin@forja.dev",
        role: "admin",
        passwordHash: hash,
        createdAt: new Date().toISOString(),
      })
      .run();
  });

  afterEach(() => {
    sqlite.close();
    clearAppKey();
    clearVerifierForTest();
    resetAccess();
    vi.restoreAllMocks();
  });

  async function getApp() {
    return buildApp({
      agentClient: { callAction: vi.fn() } as never,
      skipRateLimit: true,
    });
  }

  describe("POST /api/auth/login", () => {
    it("logs in with valid credentials (no TOTP)", async () => {
      const app = await getApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { password: "correct-password" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe("ok");
      expect(body.user.email).toBe("admin@forja.dev");
      expect(body.csrfToken).toBeTruthy();
      expect(res.headers["set-cookie"]).toContain("forja_session=");
    });

    it("rejects wrong password", async () => {
      const app = await getApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { password: "wrong-password" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("INVALID_CREDENTIALS");
    });

    it("rejects unknown email", async () => {
      setVerifierForTest(async () => ({
        email: "unknown@forja.dev",
        sub: "u2",
      }));

      const app = await getApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { password: "any" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects without Access JWT", async () => {
      const app = await getApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { password: "test" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("NO_ACCESS_TOKEN");
    });

    it("returns totp_required when TOTP is configured", async () => {
      const secret = "JBSWY3DPEHPK3PXP";
      db.update(schema.users)
        .set({ totpSecretEnc: encryptSecret(secret) })
        .run();

      const app = await getApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { password: "correct-password" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("totp_required");
      expect(res.json().totpToken).toBeTruthy();
    });
  });

  describe("POST /api/auth/login/totp", () => {
    it("completes login with valid TOTP code", async () => {
      const secret = "JBSWY3DPEHPK3PXP";
      db.update(schema.users)
        .set({ totpSecretEnc: encryptSecret(secret) })
        .run();

      const totp = new TOTP({ secret, period: 30, digits: 6, algorithm: "SHA1" });
      const code = totp.generate();
      const totpToken = signTotpToken(1, "admin@forja.dev");

      const app = await getApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login/totp",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { code, totpToken },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("ok");
      expect(res.json().csrfToken).toBeTruthy();
    });

    it("rejects invalid TOTP code", async () => {
      const secret = "JBSWY3DPEHPK3PXP";
      db.update(schema.users)
        .set({ totpSecretEnc: encryptSecret(secret) })
        .run();

      const totpToken = signTotpToken(1, "admin@forja.dev");

      const app = await getApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login/totp",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { code: "000000", totpToken },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("INVALID_TOTP");
    });
  });

  describe("POST /api/auth/login/totp token forgery", () => {
    async function setupTotp() {
      const secret = "JBSWY3DPEHPK3PXP";
      db.update(schema.users)
        .set({ totpSecretEnc: encryptSecret(secret) })
        .run();
      const totp = new TOTP({ secret, period: 30, digits: 6, algorithm: "SHA1" });
      return totp.generate();
    }

    async function postTotp(code: string, totpToken: string) {
      const app = await getApp();
      return app.inject({
        method: "POST",
        url: "/api/auth/login/totp",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { code, totpToken },
      });
    }

    it("rejects an unsigned (legacy base64 JSON) token", async () => {
      const code = await setupTotp();
      const forged = Buffer.from(
        JSON.stringify({ userId: 1, ts: Date.now() }),
      ).toString("base64url");
      const res = await postTotp(code, forged);
      expect(res.statusCode).toBe(400);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects a token with a tampered payload", async () => {
      const code = await setupTotp();
      const good = signTotpToken(2, "admin@forja.dev");
      const sig = good.split(".")[1];
      const payload = Buffer.from(
        JSON.stringify({ p: "totp-login", userId: 1, email: "admin@forja.dev", ts: Date.now() }),
      ).toString("base64url");
      const res = await postTotp(code, `${payload}.${sig}`);
      expect(res.statusCode).toBe(400);
    });

    it("rejects a token signed with another key", async () => {
      const code = await setupTotp();
      const token = signTotpToken(1, "admin@forja.dev");
      setAppKeyForTest(randomBytes(32));
      const res = await postTotp(code, token);
      expect(res.statusCode).toBe(400);
    });

    it("rejects a token issued to a different Access identity", async () => {
      const code = await setupTotp();
      const res = await postTotp(code, signTotpToken(1, "other@forja.dev"));
      expect(res.statusCode).toBe(400);
      expect(res.headers["set-cookie"]).toBeUndefined();
    });

    it("rejects an expired token", async () => {
      const code = await setupTotp();
      const res = await postTotp(
        code,
        signTotpToken(1, "admin@forja.dev", Date.now() - 6 * 60 * 1000),
      );
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("TOKEN_EXPIRED");
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns user info with valid session", async () => {
      const app = await getApp();
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { password: "correct-password" },
      });
      const cookie = loginRes.headers["set-cookie"] as string;

      const meRes = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie },
      });
      expect(meRes.statusCode).toBe(200);
      expect(meRes.json().user.email).toBe("admin@forja.dev");
    });

    it("returns 401 without session", async () => {
      const app = await getApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/auth/me",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("POST /api/auth/logout", () => {
    it("clears the session", async () => {
      const app = await getApp();
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { password: "correct-password" },
      });
      const cookie = loginRes.headers["set-cookie"] as string;
      const csrfToken = loginRes.json().csrfToken;

      const logoutRes = await app.inject({
        method: "POST",
        url: "/api/auth/logout",
        headers: { cookie, "x-csrf-token": csrfToken },
      });
      expect(logoutRes.statusCode).toBe(200);
      expect(logoutRes.json().ok).toBe(true);

      const meRes = await app.inject({
        method: "GET",
        url: "/api/auth/me",
        headers: { cookie },
      });
      expect(meRes.statusCode).toBe(401);
    });
  });

  describe("rate limiting", () => {
    async function getLimitedApp() {
      return buildApp({ agentClient: { callAction: vi.fn() } as never });
    }

    it("limits /api/auth/login to 5 attempts per minute", async () => {
      const app = await getLimitedApp();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: { "cf-access-jwt-assertion": "token" },
          payload: { password: "wrong-password" },
        });
        statuses.push(res.statusCode);
      }
      expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
      expect(statuses[5]).toBe(429);
    });

    it("limits /api/auth/login/totp to 5 attempts per minute", async () => {
      const app = await getLimitedApp();
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/api/auth/login/totp",
          headers: { "cf-access-jwt-assertion": "token" },
          payload: { code: "000000", totpToken: "not-a-token" },
        });
        statuses.push(res.statusCode);
      }
      expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
      expect(statuses[5]).toBe(429);
    });
  });

  describe("security headers", () => {
    it("does not allow unsafe-inline in style-src", async () => {
      const app = await getApp();
      const res = await app.inject({ method: "GET", url: "/api/system/health" });
      const csp = String(res.headers["content-security-policy"]);
      expect(csp).toContain("style-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
    });
  });
});
