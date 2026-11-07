import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { setAppKeyForTest, clearAppKey, hashPassword } from "./crypto.js";
import {
  configureAccess,
  resetAccess,
  setVerifierForTest,
  clearVerifierForTest,
} from "./access.js";
import { createSession } from "./session.js";
import {
  requireAccess,
  requireSession,
  requireCSRF,
  requireAdmin,
} from "./middleware.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

let sqlite: InstanceType<typeof Database>;

function buildTestApp() {
  const app = Fastify({ logger: false });
  app.register(cookie);

  app.get("/access", { preHandler: [requireAccess] }, (req) => ({
    email: req.accessClaims!.email,
  }));

  app.get(
    "/protected",
    { preHandler: [requireSession] },
    (req) => ({ user: req.session!.user }),
  );

  app.post(
    "/csrf",
    { preHandler: [requireSession, requireCSRF] },
    () => ({ ok: true }),
  );

  app.get(
    "/admin",
    { preHandler: [requireSession, requireAdmin] },
    () => ({ ok: true }),
  );

  return app;
}

describe("middleware", () => {
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

    const hash = await hashPassword("test123");
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

  describe("requireAccess", () => {
    it("passes with a valid JWT", async () => {
      setVerifierForTest(async () => ({
        email: "admin@forja.dev",
        sub: "u1",
      }));

      const app = buildTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/access",
        headers: { "cf-access-jwt-assertion": "valid-token" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().email).toBe("admin@forja.dev");
    });

    it("rejects without JWT header", async () => {
      const app = buildTestApp();
      const res = await app.inject({ method: "GET", url: "/access" });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("NO_ACCESS_TOKEN");
    });

    it("rejects with invalid JWT", async () => {
      setVerifierForTest(async () => {
        throw new Error("bad token");
      });

      const app = buildTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/access",
        headers: { "cf-access-jwt-assertion": "bad-token" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("INVALID_ACCESS_TOKEN");
    });
  });

  describe("requireSession", () => {
    it("passes with a valid session cookie", async () => {
      const { sessionId } = await createSession(1, "127.0.0.1", "Test");
      const app = buildTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/protected",
        cookies: { forja_session: sessionId },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.email).toBe("admin@forja.dev");
    });

    it("rejects without cookie", async () => {
      const app = buildTestApp();
      const res = await app.inject({ method: "GET", url: "/protected" });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("NO_SESSION");
    });

    it("rejects with invalid session ID", async () => {
      const app = buildTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/protected",
        cookies: { forja_session: "nonexistent" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("INVALID_SESSION");
    });
  });

  describe("requireCSRF", () => {
    it("passes with valid CSRF token", async () => {
      const { sessionId, csrfToken } = await createSession(1, "127.0.0.1", "Test");
      const app = buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/csrf",
        cookies: { forja_session: sessionId },
        headers: { "x-csrf-token": csrfToken },
      });
      expect(res.statusCode).toBe(200);
    });

    it("rejects without CSRF header", async () => {
      const { sessionId } = await createSession(1, "127.0.0.1", "Test");
      const app = buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/csrf",
        cookies: { forja_session: sessionId },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("MISSING_CSRF");
    });

    it("rejects with wrong CSRF token", async () => {
      const { sessionId } = await createSession(1, "127.0.0.1", "Test");
      const app = buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/csrf",
        cookies: { forja_session: sessionId },
        headers: { "x-csrf-token": "wrong-token" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("INVALID_CSRF");
    });
  });

  describe("requireAdmin", () => {
    it("passes for admin user", async () => {
      const { sessionId } = await createSession(1, "127.0.0.1", "Test");
      const app = buildTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/admin",
        cookies: { forja_session: sessionId },
      });
      expect(res.statusCode).toBe(200);
    });

    it("rejects for client user", async () => {
      const hash = await hashPassword("client123");
      db.insert(schema.users)
        .values({
          email: "client@forja.dev",
          role: "client",
          passwordHash: hash,
          createdAt: new Date().toISOString(),
        })
        .run();

      const { sessionId } = await createSession(2, "127.0.0.1", "Test");
      const app = buildTestApp();
      const res = await app.inject({
        method: "GET",
        url: "/admin",
        cookies: { forja_session: sessionId },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("FORBIDDEN");
    });
  });
});
