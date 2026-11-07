import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
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

describe("removal request routes", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let mockCallAction: ReturnType<typeof vi.fn>;

  // Users: 1 admin, 2 client A (account 1), 3 client B (account 2).
  // Sites: 1 in account 1, 2 in account 2.
  beforeEach(async () => {
    setAppKeyForTest(randomBytes(32));
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
      .values({ name: "Basic", cpuMillis: 1000, memoryMb: 512, diskMb: 5000, maxSites: 5, maxDatabases: 3 })
      .run();
    for (const [i, slug] of ["acct1", "acct2"].entries()) {
      db.insert(schema.accounts)
        .values({
          slug,
          linuxUser: `fj-${slug}`,
          uid: 1001 + i,
          planId: 1,
          status: "active",
          createdAt: new Date().toISOString(),
        })
        .run();
      db.insert(schema.sites)
        .values({
          accountId: i + 1,
          primaryDomain: `${slug}.example.com`,
          runtime: "static",
          createdAt: new Date().toISOString(),
        })
        .run();
    }
    db.insert(schema.userAccounts).values({ userId: 2, accountId: 1 }).run();
    db.insert(schema.userAccounts).values({ userId: 3, accountId: 2 }).run();

    mockCallAction = vi.fn().mockResolvedValue({ ok: true, result: {} });
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

  async function create(
    app: Awaited<ReturnType<typeof getApp>>,
    s: { cookie: string; csrf: string },
    siteId: number,
    payload: unknown = { reason: "Ya no lo necesito" },
  ) {
    return app.inject({
      method: "POST",
      url: `/api/sites/${siteId}/removal-request`,
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
      payload: payload as object,
    });
  }

  async function review(
    app: Awaited<ReturnType<typeof getApp>>,
    s: { cookie: string; csrf: string },
    id: number,
    status: unknown,
  ) {
    return app.inject({
      method: "PATCH",
      url: `/api/removal-requests/${id}`,
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
      payload: { status },
    });
  }

  describe("POST /api/sites/:siteId/removal-request", () => {
    it("requires a session", async () => {
      const app = await getApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/sites/1/removal-request",
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });

    it("requires a CSRF token", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const res = await app.inject({
        method: "POST",
        url: "/api/sites/1/removal-request",
        headers: { cookie: s.cookie },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it("a client creates a request for their own site and it is audited", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const res = await create(app, s, 1);
      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        siteId: 1,
        requestedBy: 2,
        reason: "Ya no lo necesito",
        status: "open",
        reviewedBy: null,
      });
      const audit = db.select().from(schema.auditLog).all();
      expect(audit.some((a) => a.action === "removal_request.create" && a.result === "ok")).toBe(true);
    });

    it("reason is optional", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const res = await create(app, s, 1, {});
      expect(res.statusCode).toBe(201);
      expect(res.json().reason).toBeNull();
    });

    it("rejects an invalid reason", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      expect((await create(app, s, 1, { reason: 42 })).statusCode).toBe(400);
      expect((await create(app, s, 1, { reason: "x".repeat(1001) })).statusCode).toBe(400);
    });

    it("an admin can also create a request", async () => {
      const app = await getApp();
      const s = await login(app, "admin@forja.dev");
      expect((await create(app, s, 2)).statusCode).toBe(201);
    });

    it("does not duplicate an open request, but allows a new one after review", async () => {
      const app = await getApp();
      const client = await login(app, "a@forja.dev");
      const admin = await login(app, "admin@forja.dev");
      expect((await create(app, client, 1)).statusCode).toBe(201);
      const dup = await create(app, client, 1);
      expect(dup.statusCode).toBe(409);
      expect(dup.json().error.code).toBe("REQUEST_ALREADY_OPEN");

      await review(app, admin, 1, "rejected");
      expect((await create(app, client, 1)).statusCode).toBe(201);
    });

    it("returns 404 for a missing site and 400 for an invalid id", async () => {
      const app = await getApp();
      const s = await login(app, "admin@forja.dev");
      expect((await create(app, s, 99)).statusCode).toBe(404);
      expect((await create(app, s, 0)).statusCode).toBe(400);
    });

    it("a client cannot request the removal of another client's site", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const res = await create(app, s, 2);
      expect(res.statusCode).toBe(403);
      expect(db.select().from(schema.removalRequests).all()).toHaveLength(0);
    });
  });

  describe("GET /api/removal-requests", () => {
    async function seed(app: Awaited<ReturnType<typeof getApp>>) {
      const a = await login(app, "a@forja.dev");
      const b = await login(app, "b@forja.dev");
      const admin = await login(app, "admin@forja.dev");
      await create(app, a, 1, { reason: "A" });
      await create(app, b, 2, { reason: "B" });
      return { a, b, admin };
    }

    it("requires a session", async () => {
      const app = await getApp();
      expect((await app.inject({ method: "GET", url: "/api/removal-requests" })).statusCode).toBe(401);
    });

    it("admin sees every request with site and account info", async () => {
      const app = await getApp();
      const { admin } = await seed(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/removal-requests",
        headers: { cookie: admin.cookie },
      });
      expect(res.statusCode).toBe(200);
      const rows = res.json();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        accountSlug: "acct2",
        domain: "acct2.example.com",
        requestedByEmail: "b@forja.dev",
        status: "open",
      });
    });

    it("a client only sees requests of their own accounts", async () => {
      const app = await getApp();
      const { a, b } = await seed(app);
      const resA = await app.inject({
        method: "GET",
        url: "/api/removal-requests",
        headers: { cookie: a.cookie },
      });
      expect(resA.json().map((r: { reason: string }) => r.reason)).toEqual(["A"]);
      const resB = await app.inject({
        method: "GET",
        url: "/api/removal-requests",
        headers: { cookie: b.cookie },
      });
      expect(resB.json().map((r: { reason: string }) => r.reason)).toEqual(["B"]);
    });

    it("a client with no accounts gets an empty list", async () => {
      const app = await getApp();
      const { a } = await seed(app);
      db.delete(schema.userAccounts).where(eq(schema.userAccounts.userId, 2)).run();
      const res = await app.inject({
        method: "GET",
        url: "/api/removal-requests",
        headers: { cookie: a.cookie },
      });
      expect(res.json()).toEqual([]);
    });

    it("filters by status and validates it", async () => {
      const app = await getApp();
      const { admin } = await seed(app);
      await review(app, admin, 1, "rejected");
      const open = await app.inject({
        method: "GET",
        url: "/api/removal-requests?status=open",
        headers: { cookie: admin.cookie },
      });
      expect(open.json()).toHaveLength(1);
      const bad = await app.inject({
        method: "GET",
        url: "/api/removal-requests?status=nope",
        headers: { cookie: admin.cookie },
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  describe("PATCH /api/removal-requests/:id", () => {
    async function seedOne(app: Awaited<ReturnType<typeof getApp>>) {
      const client = await login(app, "a@forja.dev");
      const admin = await login(app, "admin@forja.dev");
      await create(app, client, 1);
      return { client, admin };
    }

    it("a client cannot review, not even their own request", async () => {
      const app = await getApp();
      const { client } = await seedOne(app);
      const res = await review(app, client, 1, "done");
      expect(res.statusCode).toBe(403);
      expect(db.select().from(schema.removalRequests).get()?.status).toBe("open");
      expect(mockCallAction).not.toHaveBeenCalled();
    });

    it("another client cannot review it either", async () => {
      const app = await getApp();
      await seedOne(app);
      const other = await login(app, "b@forja.dev");
      expect((await review(app, other, 1, "rejected")).statusCode).toBe(403);
    });

    it("requires CSRF", async () => {
      const app = await getApp();
      const { admin } = await seedOne(app);
      const res = await app.inject({
        method: "PATCH",
        url: "/api/removal-requests/1",
        headers: { cookie: admin.cookie },
        payload: { status: "done" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("rejecting records the reviewer and leaves the site untouched", async () => {
      const app = await getApp();
      const { admin } = await seedOne(app);
      const res = await review(app, admin, 1, "rejected");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "rejected", reviewedBy: 1 });
      expect(res.json().reviewedAt).toBeTruthy();
      expect(db.select().from(schema.sites).where(eq(schema.sites.id, 1)).get()?.mode).toBe("online");
      expect(mockCallAction).not.toHaveBeenCalled();
    });

    it("approving disables the site through the agent and syncs Caddy", async () => {
      const app = await getApp();
      const { admin } = await seedOne(app);
      const res = await review(app, admin, 1, "done");
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("done");
      expect(db.select().from(schema.sites).where(eq(schema.sites.id, 1)).get()?.mode).toBe("disabled");
      expect(mockCallAction).toHaveBeenCalledWith("site.set_mode", {
        account_slug: "acct1",
        domain: "acct1.example.com",
        mode: "disabled",
      });
      expect(mockCallAction.mock.calls.map((c) => c[0])).toContain("caddy.sync");
      const audit = db.select().from(schema.auditLog).all();
      expect(audit.some((a) => a.action === "removal_request.review" && a.result === "ok")).toBe(true);
    });

    it("keeps the request open when the agent fails", async () => {
      const app = await getApp();
      const { admin } = await seedOne(app);
      mockCallAction.mockResolvedValueOnce({
        ok: false,
        error: { code: "BOOM", message: "systemctl: /etc/caddy/Caddyfile:12 unit failed" },
      });
      const res = await review(app, admin, 1, "done");
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toEqual({ code: "AGENT_ERROR", message: "Agent action failed" });
      expect(res.body).not.toContain("/etc/caddy");
      expect(db.select().from(schema.removalRequests).get()?.status).toBe("open");
      expect(db.select().from(schema.sites).where(eq(schema.sites.id, 1)).get()?.mode).toBe("online");
      const audit = db.select().from(schema.auditLog).all();
      expect(audit.some((a) => a.action === "removal_request.review" && a.result === "error")).toBe(true);
    });

    it("cannot review twice", async () => {
      const app = await getApp();
      const { admin } = await seedOne(app);
      await review(app, admin, 1, "rejected");
      const res = await review(app, admin, 1, "done");
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("ALREADY_REVIEWED");
    });

    it("validates status, id and existence", async () => {
      const app = await getApp();
      const { admin } = await seedOne(app);
      expect((await review(app, admin, 1, "open")).statusCode).toBe(400);
      expect((await review(app, admin, 1, undefined)).statusCode).toBe(400);
      expect((await review(app, admin, 0, "done")).statusCode).toBe(400);
      expect((await review(app, admin, 99, "done")).statusCode).toBe(404);
    });
  });
});
