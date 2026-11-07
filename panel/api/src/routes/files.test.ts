import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { buildApp } from "../app.js";
import { setAppKeyForTest, clearAppKey, hashPassword } from "../auth/crypto.js";
import {
  configureAccess,
  resetAccess,
  setVerifierForTest,
  clearVerifierForTest,
} from "../auth/access.js";
import { setSecretKeyForTest, clearSecretKey } from "../crypto/secrets.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

let sqlite: InstanceType<typeof Database>;

describe("file routes", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let mockCallAction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    setAppKeyForTest(randomBytes(32));
    setSecretKeyForTest(randomBytes(32));
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

    const hash = await hashPassword("password123");
    db.insert(schema.users)
      .values({
        email: "admin@forja.dev",
        role: "admin",
        passwordHash: hash,
        createdAt: new Date().toISOString(),
      })
      .run();

    db.insert(schema.plans)
      .values({
        name: "Basic",
        cpuMillis: 1000,
        memoryMb: 512,
        diskMb: 5000,
        maxSites: 5,
        maxDatabases: 3,
      })
      .run();

    db.insert(schema.accounts)
      .values({
        slug: "demo",
        linuxUser: "fj-demo",
        uid: 1001,
        planId: 1,
        status: "active",
        createdAt: new Date().toISOString(),
      })
      .run();

    mockCallAction = vi.fn().mockResolvedValue({ ok: true, result: {} });
  });

  afterEach(() => {
    sqlite.close();
    clearAppKey();
    clearSecretKey();
    resetAccess();
    clearVerifierForTest();
    vi.restoreAllMocks();
  });

  type App = Awaited<ReturnType<typeof buildApp>>;

  async function makeApp() {
    return buildApp({
      agentClient: { callAction: mockCallAction } as unknown as import("../agent/client.js").AgentClient,
      skipRateLimit: true,
    });
  }

  async function login(app: App) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: {
        "cf-access-jwt-assertion": "test-jwt",
      },
      payload: { email: "admin@forja.dev", password: "password123" },
    });
    const cookies = res.headers["set-cookie"];
    const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : (cookies ?? "");
    const csrf = (res.json() as { csrfToken: string }).csrfToken;
    return { cookie: cookieStr, csrf };
  }

  describe("GET /api/accounts/:accountId/files", () => {
    it("lists files", async () => {
      mockCallAction.mockResolvedValue({
        ok: true,
        result: {
          entries: [
            { name: "index.js", type: "file", size: 100, mod_time: 1699000000, permissions: "0644" },
          ],
          path: ".",
        },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/1/files?path=.",
        headers: { cookie: auth.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.entries).toHaveLength(1);
      expect(body.entries[0].name).toBe("index.js");
    });

    it("returns 404 for missing account", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/999/files",
        headers: { cookie: auth.cookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it("rejects unauthenticated request", async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/1/files",
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("GET /api/accounts/:accountId/files/content", () => {
    it("reads a file", async () => {
      mockCallAction.mockResolvedValue({
        ok: true,
        result: {
          name: "index.js",
          content: "console.log('hi')",
          encoding: "utf-8",
          size: 17,
        },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/1/files/content?path=index.js",
        headers: { cookie: auth.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().content).toBe("console.log('hi')");
    });

    it("returns 400 without path", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/1/files/content",
        headers: { cookie: auth.cookie },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("PUT /api/accounts/:accountId/files/content", () => {
    it("writes a file", async () => {
      mockCallAction.mockResolvedValue({
        ok: true,
        result: { path: "test.txt", size: 5 },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "PUT",
        url: "/api/accounts/1/files/content",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { path: "test.txt", content: "hello" },
      });
      expect(res.statusCode).toBe(200);
      expect(mockCallAction).toHaveBeenCalledWith("files.write", {
        account_slug: "demo",
        path: "test.txt",
        content: "hello",
      });
    });

    it("returns 400 without path", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "PUT",
        url: "/api/accounts/1/files/content",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { content: "hello" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("DELETE /api/accounts/:accountId/files", () => {
    it("deletes a file", async () => {
      mockCallAction.mockResolvedValue({
        ok: true,
        result: { path: "old.js" },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "DELETE",
        url: "/api/accounts/1/files?path=old.js",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(204);
    });

    it("returns 400 without path", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "DELETE",
        url: "/api/accounts/1/files",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(400);
    });

    it("passes recursive flag", async () => {
      mockCallAction.mockResolvedValue({
        ok: true,
        result: { path: "node_modules" },
      });

      const app = await makeApp();
      const auth = await login(app);
      await app.inject({
        method: "DELETE",
        url: "/api/accounts/1/files?path=node_modules&recursive=true",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(mockCallAction).toHaveBeenCalledWith("files.delete", {
        account_slug: "demo",
        path: "node_modules",
        recursive: true,
      });
    });
  });

  describe("POST /api/accounts/:accountId/files/mkdir", () => {
    it("creates a directory", async () => {
      mockCallAction.mockResolvedValue({
        ok: true,
        result: { path: "newdir" },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/files/mkdir",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { path: "newdir" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("returns 400 without path", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/files/mkdir",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/accounts/:accountId/files/upload", () => {
    it("uploads a file", async () => {
      mockCallAction.mockResolvedValue({
        ok: true,
        result: { path: "file.bin", size: 5 },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/files/upload",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { path: "file.bin", content_base64: "aGVsbG8=" },
      });
      expect(res.statusCode).toBe(201);
      expect(mockCallAction).toHaveBeenCalledWith("files.upload", {
        account_slug: "demo",
        path: "file.bin",
        content_base64: "aGVsbG8=",
      });
    });

    it("returns 400 without content", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/files/upload",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { path: "file.bin" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("agent error handling", () => {
    it("returns 502 on agent failure", async () => {
      mockCallAction.mockResolvedValue({
        ok: false,
        error: { code: "EXECUTE", message: "permission denied" },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/1/files?path=.",
        headers: { cookie: auth.cookie },
      });
      expect(res.statusCode).toBe(502);
    });
  });
});
