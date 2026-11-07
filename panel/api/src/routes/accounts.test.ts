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
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

let sqlite: InstanceType<typeof Database>;

describe("account routes", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let mockCallAction: ReturnType<typeof vi.fn>;

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

    mockCallAction = vi.fn().mockResolvedValue({
      ok: true,
      result: {
        linux_user: "fj-demo",
        uid: 1001,
        home_dir: "/srv/forja/accounts/demo",
      },
    });
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
      agentClient: { callAction: mockCallAction } as never,
      skipRateLimit: true,
    });
  }

  async function loginAdmin(app: Awaited<ReturnType<typeof getApp>>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "cf-access-jwt-assertion": "token" },
      payload: { password: "password123" },
    });
    const cookie = res.headers["set-cookie"] as string;
    const csrf = res.json().csrfToken;
    return { cookie, csrf };
  }

  describe("POST /api/accounts", () => {
    it("creates an account via agent", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.slug).toBe("demo");
      expect(body.linuxUser).toBe("fj-demo");
      expect(body.uid).toBe(1001);
      expect(body.status).toBe("active");

      expect(mockCallAction).toHaveBeenCalledWith("account.create", {
        slug: "demo",
        cpu_millis: 1000,
        memory_mb: 512,
        disk_mb: 5000,
      });
    });

    it("rejects non-existent plan", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 999 },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("PLAN_NOT_FOUND");
    });

    it("rejects duplicate slug", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("DUPLICATE");
    });

    it("returns 502 when agent fails", async () => {
      mockCallAction.mockResolvedValue({
        ok: false,
        error: { code: "USER_EXISTS", message: "useradd: /srv/forja/accounts/demo exists (shadow-utils 4.13)" },
      });

      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("AGENT_ERROR");
      expect(res.body).not.toContain("/srv/forja");
      expect(res.body).not.toContain("shadow-utils");
    });

    it("writes audit on agent error", async () => {
      mockCallAction.mockResolvedValue({
        ok: false,
        error: { code: "AGENT_FAIL", message: "failed" },
      });

      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });

      const logs = db.select().from(schema.auditLog).all();
      const entry = logs.find((l) => l.action === "account.create");
      expect(entry).toBeDefined();
      expect(entry!.result).toBe("error");
    });

    it("writes audit on success", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });

      const logs = db.select().from(schema.auditLog).all();
      const entry = logs.find((l) => l.action === "account.create");
      expect(entry).toBeDefined();
      expect(entry!.result).toBe("ok");
    });

    it("rejects non-admin", async () => {
      db.insert(schema.users)
        .values({
          email: "client@forja.dev",
          role: "client",
          passwordHash: await hashPassword("password123"),
          createdAt: new Date().toISOString(),
        })
        .run();

      setVerifierForTest(async () => ({
        email: "client@forja.dev",
        sub: "u2",
      }));

      const app = await getApp();
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { password: "password123" },
      });

      const cookie = loginRes.headers["set-cookie"] as string;
      const csrf = loginRes.json().csrfToken;

      const res = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("GET /api/accounts", () => {
    it("lists accounts", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/accounts",
        headers: { cookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
      expect(res.json()[0].slug).toBe("demo");
    });
  });

  describe("GET /api/accounts/:id", () => {
    it("gets a single account", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const createRes = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });
      const accountId = createRes.json().id;

      const res = await app.inject({
        method: "GET",
        url: `/api/accounts/${accountId}`,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().slug).toBe("demo");
    });

    it("returns 404 for non-existent account", async () => {
      const app = await getApp();
      const { cookie } = await loginAdmin(app);

      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/9999",
        headers: { cookie },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/accounts/:id/suspend", () => {
    it("suspends an active account", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const createRes = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });
      const accountId = createRes.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/accounts/${accountId}/suspend`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("suspended");
    });

    it("rejects suspending already suspended account", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const createRes = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });
      const accountId = createRes.json().id;

      await app.inject({
        method: "POST",
        url: `/api/accounts/${accountId}/suspend`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/accounts/${accountId}/suspend`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("ALREADY_SUSPENDED");
    });
  });

  describe("POST /api/accounts/:id/resume", () => {
    it("resumes a suspended account", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const createRes = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });
      const accountId = createRes.json().id;

      await app.inject({
        method: "POST",
        url: `/api/accounts/${accountId}/suspend`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/accounts/${accountId}/resume`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("active");
    });

    it("rejects resuming already active account", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const createRes = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });
      const accountId = createRes.json().id;

      const res = await app.inject({
        method: "POST",
        url: `/api/accounts/${accountId}/resume`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("ALREADY_ACTIVE");
    });

    it("writes audit on suspend", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const createRes = await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { slug: "demo", planId: 1 },
      });
      const accountId = createRes.json().id;

      await app.inject({
        method: "POST",
        url: `/api/accounts/${accountId}/suspend`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      const logs = db.select().from(schema.auditLog).all();
      const suspendLog = logs.find((l) => l.action === "account.suspend");
      expect(suspendLog).toBeDefined();
      expect(suspendLog!.result).toBe("ok");
    });
  });
});
