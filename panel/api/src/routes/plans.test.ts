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

describe("plan routes", () => {
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

    const hash = await hashPassword("password123");
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

  const validPlan = {
    name: "Basic",
    cpuMillis: 1000,
    memoryMb: 512,
    diskMb: 5000,
    maxSites: 5,
    maxDatabases: 3,
  };

  describe("POST /api/plans", () => {
    it("creates a plan", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/plans",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validPlan,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.name).toBe("Basic");
      expect(body.cpuMillis).toBe(1000);
      expect(body.id).toBeDefined();
    });

    it("rejects duplicate name", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      await app.inject({
        method: "POST",
        url: "/api/plans",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validPlan,
      });

      const res = await app.inject({
        method: "POST",
        url: "/api/plans",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validPlan,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("DUPLICATE");
    });

    it("rejects invalid body", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/plans",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { name: "", cpuMillis: 0, memoryMb: 0, diskMb: 0, maxSites: 0, maxDatabases: -1 },
      });

      expect(res.statusCode).toBe(400);
    });

    it("rejects without CSRF token", async () => {
      const app = await getApp();
      const { cookie } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/plans",
        headers: { cookie },
        payload: validPlan,
      });

      expect(res.statusCode).toBe(403);
    });

    it("rejects non-admin (client role)", async () => {
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
        url: "/api/plans",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validPlan,
      });

      expect(res.statusCode).toBe(403);
    });

    it("writes audit log on create", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      await app.inject({
        method: "POST",
        url: "/api/plans",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validPlan,
      });

      const logs = db.select().from(schema.auditLog).all();
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe("plan.create");
      expect(logs[0].result).toBe("ok");
    });
  });

  describe("GET /api/plans", () => {
    it("lists all plans", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      await app.inject({
        method: "POST",
        url: "/api/plans",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validPlan,
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/plans",
        headers: { cookie },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe("Basic");
    });
  });

  describe("PUT /api/plans/:id", () => {
    it("updates a plan", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const createRes = await app.inject({
        method: "POST",
        url: "/api/plans",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validPlan,
      });
      const planId = createRes.json().id;

      const res = await app.inject({
        method: "PUT",
        url: `/api/plans/${planId}`,
        headers: { cookie, "x-csrf-token": csrf },
        payload: { ...validPlan, name: "Pro", cpuMillis: 2000 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe("Pro");
      expect(res.json().cpuMillis).toBe(2000);
    });

    it("returns 404 for non-existent plan", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "PUT",
        url: "/api/plans/9999",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validPlan,
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("DELETE /api/plans/:id", () => {
    it("deletes a plan with no accounts", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const createRes = await app.inject({
        method: "POST",
        url: "/api/plans",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validPlan,
      });
      const planId = createRes.json().id;

      const res = await app.inject({
        method: "DELETE",
        url: `/api/plans/${planId}`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      expect(res.statusCode).toBe(204);

      const list = await app.inject({
        method: "GET",
        url: "/api/plans",
        headers: { cookie },
      });
      expect(list.json()).toHaveLength(0);
    });

    it("rejects delete when plan has accounts", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const createRes = await app.inject({
        method: "POST",
        url: "/api/plans",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validPlan,
      });
      const planId = createRes.json().id;

      db.insert(schema.accounts)
        .values({
          slug: "test-acct",
          linuxUser: "fj-test-acct",
          uid: 1001,
          planId,
          status: "active",
          createdAt: new Date().toISOString(),
        })
        .run();

      const res = await app.inject({
        method: "DELETE",
        url: `/api/plans/${planId}`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("HAS_ACCOUNTS");
    });

    it("writes audit log on delete", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const createRes = await app.inject({
        method: "POST",
        url: "/api/plans",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validPlan,
      });
      const planId = createRes.json().id;

      await app.inject({
        method: "DELETE",
        url: `/api/plans/${planId}`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      const logs = db.select().from(schema.auditLog).all();
      const deleteLog = logs.find((l) => l.action === "plan.delete");
      expect(deleteLog).toBeDefined();
      expect(deleteLog!.targetId).toBe(String(planId));
    });
  });
});
