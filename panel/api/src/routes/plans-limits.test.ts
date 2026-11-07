import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { buildApp } from "../app.js";
import { setAppKeyForTest, clearAppKey, hashPassword } from "../auth/crypto.js";
import { setSecretKeyForTest, clearSecretKey } from "../crypto/secrets.js";
import {
  configureAccess,
  resetAccess,
  setVerifierForTest,
  clearVerifierForTest,
} from "../auth/access.js";
import { checkPlanLimit } from "../plans/limits.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

let sqlite: InstanceType<typeof Database>;

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("plan limits", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let mockCallAction: ReturnType<typeof vi.fn>;

  // Users: 1 admin, 2 client A (account 1), 3 client B (account 2).
  // Plan 1 "Tiny": 2 sites, 1 database, 2500m CPU, 1536 MB. Plan 2 "Big" for account 2.
  beforeEach(async () => {
    setAppKeyForTest(randomBytes(32));
    setSecretKeyForTest(randomBytes(32));
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    vi.mocked(getDB).mockReturnValue(db);
    configureAccess({ teamDomain: "test.cloudflareaccess.com", audience: "test-aud" });

    const hash = await hashPassword("password123");
    for (const [email, role] of [
      ["admin@forja.dev", "admin"],
      ["a@forja.dev", "client"],
      ["b@forja.dev", "client"],
    ] as const) {
      db.insert(schema.users)
        .values({ email, role, passwordHash: hash, createdAt: new Date().toISOString() })
        .run();
    }
    db.insert(schema.plans)
      .values([
        { name: "Tiny", cpuMillis: 2500, memoryMb: 1536, diskMb: 2000, maxSites: 2, maxDatabases: 1 },
        { name: "Big", cpuMillis: 4000, memoryMb: 4096, diskMb: 20000, maxSites: 20, maxDatabases: 10 },
      ])
      .run();
    for (const [i, slug] of ["acct1", "acct2"].entries()) {
      db.insert(schema.accounts)
        .values({
          slug,
          linuxUser: `fj-${slug}`,
          uid: 1001 + i,
          planId: i + 1,
          status: "active",
          createdAt: new Date().toISOString(),
        })
        .run();
    }
    db.insert(schema.userAccounts).values({ userId: 2, accountId: 1 }).run();
    db.insert(schema.userAccounts).values({ userId: 3, accountId: 2 }).run();

    mockCallAction = vi.fn().mockImplementation(async (action: string) => {
      if (action === "site.create") {
        return { ok: true, result: { site_dir: "/x", port_blue: 10000, port_green: 10001 } };
      }
      if (action === "site.deploy") {
        return { ok: true, result: { container_name: "c", active_port: 10001 } };
      }
      if (action === "db.create") {
        return { ok: true, result: {} };
      }
      return { ok: true, result: {} };
    });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ sha: "abc1234567890abc1234567890abc1234567890a" }),
    });
  });

  afterEach(() => {
    sqlite.close();
    clearAppKey();
    clearSecretKey();
    clearVerifierForTest();
    resetAccess();
    vi.restoreAllMocks();
    mockFetch.mockReset();
  });

  async function getApp() {
    return buildApp({
      agentClient: { callAction: mockCallAction } as never,
      skipRateLimit: true,
    });
  }

  async function login(app: Awaited<ReturnType<typeof getApp>>, email: string) {
    setVerifierForTest(async () => ({ email, sub: "u" }));
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "cf-access-jwt-assertion": "token" },
      payload: { password: "password123" },
    });
    return {
      cookie: res.headers["set-cookie"] as string,
      csrf: res.json().csrfToken as string,
    };
  }

  function insertSites(accountId: number, n: number) {
    for (let i = 0; i < n; i++) {
      db.insert(schema.sites)
        .values({
          accountId,
          primaryDomain: `s${accountId}-${i}.example.com`,
          runtime: "node",
          source: "github",
          repo: "https://github.com/user/repo",
          branch: "main",
          internalPort: 10000 + i * 2,
          createdAt: new Date().toISOString(),
        })
        .run();
    }
  }

  function insertDatabases(accountId: number, n: number) {
    for (let i = 0; i < n; i++) {
      db.insert(schema.databases)
        .values({
          accountId,
          engine: "mariadb",
          name: `db${accountId}_${i}`,
          dbUser: `u${accountId}_${i}`,
          passwordEnc: "enc",
        })
        .run();
    }
  }

  const siteBody = (accountId: number) => ({
    accountId,
    primaryDomain: "new.example.com",
    runtime: "node",
    source: "github",
    repo: "https://github.com/user/repo",
    branch: "main",
  });

  describe("checkPlanLimit", () => {
    it("reports usage and whether one more resource is allowed", () => {
      insertSites(1, 1);
      expect(checkPlanLimit(1, "sites")).toEqual({ allowed: true, current: 1, max: 2 });
      db.insert(schema.sites)
        .values({ accountId: 1, primaryDomain: "x.example.com", runtime: "static", createdAt: "now" })
        .run();
      expect(checkPlanLimit(1, "sites")).toEqual({ allowed: false, current: 2, max: 2 });
      expect(checkPlanLimit(1, "databases")).toEqual({ allowed: true, current: 0, max: 1 });
    });

    it("only counts the resources of the given account", () => {
      insertSites(2, 5);
      expect(checkPlanLimit(1, "sites")?.current).toBe(0);
    });

    it("returns null for an unknown account", () => {
      expect(checkPlanLimit(999, "sites")).toBeNull();
    });
  });

  describe("POST /api/sites", () => {
    it("returns 409 PLAN_LIMIT when maxSites is reached", async () => {
      insertSites(1, 2);
      const app = await getApp();
      const s = await login(app, "admin@forja.dev");
      const res = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
        payload: siteBody(1),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("PLAN_LIMIT");
      expect(mockCallAction).not.toHaveBeenCalled();
      const audit = db.select().from(schema.auditLog).all();
      expect(audit.some((a) => a.action === "site.create" && a.errorCode === "PLAN_LIMIT")).toBe(true);
    });

    it("applies the limit to clients too", async () => {
      insertSites(1, 2);
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const res = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
        payload: siteBody(1),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("PLAN_LIMIT");
    });

    it("allows creation while below the limit", async () => {
      insertSites(1, 1);
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const res = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
        payload: siteBody(1),
      });
      expect(res.statusCode).toBe(201);
    });
  });

  describe("POST /api/accounts/:accountId/databases", () => {
    const payload = { engine: "mariadb", name: "extra", db_user: "extra" };

    it("returns 409 PLAN_LIMIT when maxDatabases is reached", async () => {
      insertDatabases(1, 1);
      const app = await getApp();
      const s = await login(app, "admin@forja.dev");
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
        payload,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("PLAN_LIMIT");
      expect(mockCallAction).not.toHaveBeenCalled();
    });

    it("applies the limit to clients too", async () => {
      insertDatabases(1, 1);
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
        payload,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("PLAN_LIMIT");
    });

    it("does not count databases of other accounts", async () => {
      insertDatabases(2, 5);
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
        payload,
      });
      expect(res.statusCode).toBe(201);
    });
  });

  describe("POST /api/sites/:id/deploy", () => {
    it("passes the plan CPU and memory to the agent", async () => {
      insertSites(1, 1);
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const res = await app.inject({
        method: "POST",
        url: "/api/sites/1/deploy",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
      });
      expect(res.statusCode).toBe(200);
      const call = mockCallAction.mock.calls.find((c: unknown[]) => c[0] === "site.deploy");
      expect(call![1]).toMatchObject({ cpu_millis: 2500, memory_mb: 1536 });
    });

    it("uses the limits of the plan of the site's own account", async () => {
      insertSites(2, 1);
      const app = await getApp();
      const s = await login(app, "admin@forja.dev");
      await app.inject({
        method: "POST",
        url: "/api/sites/1/deploy",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
      });
      const call = mockCallAction.mock.calls.find((c: unknown[]) => c[0] === "site.deploy");
      expect(call![1]).toMatchObject({ cpu_millis: 4000, memory_mb: 4096 });
    });
  });

  describe("GET /api/accounts/:accountId/usage", () => {
    it("requires a session", async () => {
      const app = await getApp();
      const res = await app.inject({ method: "GET", url: "/api/accounts/1/usage" });
      expect(res.statusCode).toBe(401);
    });

    it("returns current usage and plan limits", async () => {
      insertSites(1, 2);
      insertDatabases(1, 1);
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/1/usage",
        headers: { cookie: s.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        sites: { current: 2, max: 2 },
        databases: { current: 1, max: 1 },
        cpu: 2500,
        memory: 1536,
      });
    });

    it("lets an admin read any account", async () => {
      insertSites(2, 3);
      const app = await getApp();
      const s = await login(app, "admin@forja.dev");
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/2/usage",
        headers: { cookie: s.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sites).toEqual({ current: 3, max: 20 });
    });

    it("denies a client the usage of another client's account", async () => {
      insertSites(2, 3);
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/2/usage",
        headers: { cookie: s.cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(JSON.stringify(res.json())).not.toContain("20");
    });

    it("returns 400 for an invalid id and 404 for an unknown account (admin)", async () => {
      const app = await getApp();
      const s = await login(app, "admin@forja.dev");
      const bad = await app.inject({ method: "GET", url: "/api/accounts/abc/usage", headers: { cookie: s.cookie } });
      expect(bad.statusCode).toBe(400);
      const missing = await app.inject({ method: "GET", url: "/api/accounts/999/usage", headers: { cookie: s.cookie } });
      expect(missing.statusCode).toBe(404);
    });
  });
});
