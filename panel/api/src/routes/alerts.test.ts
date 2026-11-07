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
import { fireAlert } from "../alerts/engine.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

let sqlite: InstanceType<typeof Database>;

describe("alert routes and engine", () => {
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

  type App = Awaited<ReturnType<typeof getApp>>;
  type Sess = { cookie: string; csrf: string };

  async function getApp() {
    return buildApp({
      agentClient: { callAction: mockCallAction } as never,
      skipRateLimit: true,
    });
  }

  async function login(app: App, email: string): Promise<Sess> {
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

  function call(app: App, s: Sess, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: object) {
    return app.inject({
      method,
      url,
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
      payload,
    });
  }

  async function addChannel(app: App, s: Sess, address = "ops@example.com") {
    const res = await call(app, s, "POST", "/api/alerts/channels", { kind: "email", address });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: number };
  }

  async function addRule(app: App, s: Sess, event: string, channelId: number, extra: object = {}) {
    const res = await call(app, s, "POST", "/api/alerts/rules", { event, channelId, ...extra });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: number };
  }

  describe("authentication", () => {
    it("requires a session on every endpoint", async () => {
      const app = await getApp();
      for (const [method, url] of [
        ["GET", "/api/alerts/channels"],
        ["POST", "/api/alerts/channels"],
        ["PATCH", "/api/alerts/channels/1"],
        ["DELETE", "/api/alerts/channels/1"],
        ["GET", "/api/alerts/rules"],
        ["POST", "/api/alerts/rules"],
        ["DELETE", "/api/alerts/rules/1"],
        ["GET", "/api/alerts/log"],
      ] as const) {
        const res = await app.inject({ method, url, payload: method === "GET" ? undefined : {} });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    });

    it("requires a CSRF token on mutations", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const res = await app.inject({
        method: "POST",
        url: "/api/alerts/channels",
        headers: { cookie: s.cookie },
        payload: { kind: "email", address: "a@example.com" },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("channels", () => {
    it("creates, lists, updates and deletes a channel (audited)", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");

      const created = await call(app, s, "POST", "/api/alerts/channels", {
        kind: "email",
        address: "ops@example.com",
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        kind: "email",
        address: "ops@example.com",
        enabled: true,
        userId: 2,
      });
      const id = created.json().id as number;

      const list = await call(app, s, "GET", "/api/alerts/channels");
      expect(list.json()).toHaveLength(1);

      const patched = await call(app, s, "PATCH", `/api/alerts/channels/${id}`, {
        address: "new@example.com",
        enabled: false,
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json()).toMatchObject({ address: "new@example.com", enabled: false });

      const del = await call(app, s, "DELETE", `/api/alerts/channels/${id}`);
      expect(del.statusCode).toBe(204);
      expect((await call(app, s, "GET", "/api/alerts/channels")).json()).toHaveLength(0);

      const actions = db.select().from(schema.auditLog).all().map((a) => a.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "alert_channel.create",
          "alert_channel.update",
          "alert_channel.delete",
        ]),
      );
      // The address is personal data: it must not end up in the audit trail.
      const audit = JSON.stringify(db.select().from(schema.auditLog).all());
      expect(audit).not.toContain("example.com");
    });

    it("only accepts kind email", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      for (const kind of ["telegram", "sms", "", 5, undefined]) {
        const res = await call(app, s, "POST", "/api/alerts/channels", {
          kind,
          address: "a@example.com",
        });
        expect(res.statusCode, String(kind)).toBe(400);
        expect(res.json().error.code).toBe("INVALID_KIND");
      }
      const id = (await addChannel(app, s)).id;
      const patch = await call(app, s, "PATCH", `/api/alerts/channels/${id}`, { kind: "telegram" });
      expect(patch.statusCode).toBe(400);
      expect(db.select().from(schema.alertChannels).all()).toHaveLength(1);
    });

    it("rejects invalid addresses", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      for (const address of ["nope", "a@b", "a b@example.com", "a@example.com,b@example.com", 7, undefined, `${"x".repeat(250)}@example.com`]) {
        const res = await call(app, s, "POST", "/api/alerts/channels", { kind: "email", address });
        expect(res.statusCode, String(address)).toBe(400);
      }
    });

    it("PATCH without changes is a 400", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const id = (await addChannel(app, s)).id;
      expect((await call(app, s, "PATCH", `/api/alerts/channels/${id}`, {})).statusCode).toBe(400);
    });

    it("deleting a channel removes its rules and history", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const ch = await addChannel(app, s);
      await addRule(app, s, "backup_failed", ch.id);
      fireAlert("backup_failed", { accountId: 1, message: "x" });
      expect(db.select().from(schema.alertLog).all()).toHaveLength(1);

      expect((await call(app, s, "DELETE", `/api/alerts/channels/${ch.id}`)).statusCode).toBe(204);
      expect(db.select().from(schema.alertRules).all()).toHaveLength(0);
      expect(db.select().from(schema.alertLog).all()).toHaveLength(0);
    });

    it("limits channels per user", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      for (let i = 0; i < 10; i++) await addChannel(app, s, `u${i}@example.com`);
      const res = await call(app, s, "POST", "/api/alerts/channels", {
        kind: "email",
        address: "extra@example.com",
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("cross-account access (rule 6)", () => {
    it("a client does not see other users' channels, rules or log", async () => {
      const app = await getApp();
      const a = await login(app, "a@forja.dev");
      const b = await login(app, "b@forja.dev");
      const chA = await addChannel(app, a, "a@example.com");
      await addRule(app, a, "backup_failed", chA.id);
      fireAlert("backup_failed", { accountId: 1, message: "A's alert" });

      expect((await call(app, b, "GET", "/api/alerts/channels")).json()).toEqual([]);
      expect((await call(app, b, "GET", "/api/alerts/rules")).json()).toEqual([]);
      expect((await call(app, b, "GET", "/api/alerts/log")).json()).toEqual([]);
      expect((await call(app, a, "GET", "/api/alerts/log")).json()).toHaveLength(1);
    });

    it("a client cannot modify or delete another user's channel", async () => {
      const app = await getApp();
      const a = await login(app, "a@forja.dev");
      const b = await login(app, "b@forja.dev");
      const chA = await addChannel(app, a);

      const patch = await call(app, b, "PATCH", `/api/alerts/channels/${chA.id}`, { enabled: false });
      expect(patch.statusCode).toBe(404);
      const del = await call(app, b, "DELETE", `/api/alerts/channels/${chA.id}`);
      expect(del.statusCode).toBe(404);

      const row = db.select().from(schema.alertChannels).get();
      expect(row?.enabled).toBe(true);
    });

    it("a client cannot attach a rule to, or delete a rule of, another user", async () => {
      const app = await getApp();
      const a = await login(app, "a@forja.dev");
      const b = await login(app, "b@forja.dev");
      const chA = await addChannel(app, a);
      const ruleA = await addRule(app, a, "backup_failed", chA.id);

      const res = await call(app, b, "POST", "/api/alerts/rules", {
        event: "backup_failed",
        channelId: chA.id,
      });
      expect(res.statusCode).toBe(404);
      expect((await call(app, b, "DELETE", `/api/alerts/rules/${ruleA.id}`)).statusCode).toBe(404);
      expect(db.select().from(schema.alertRules).all()).toHaveLength(1);
    });

    it("an admin sees everything but still cannot attach a rule to someone else's channel", async () => {
      const app = await getApp();
      const admin = await login(app, "admin@forja.dev");
      const a = await login(app, "a@forja.dev");
      const chA = await addChannel(app, a);
      await addRule(app, a, "backup_failed", chA.id);
      fireAlert("backup_failed", { accountId: 1, message: "x" });

      expect((await call(app, admin, "GET", "/api/alerts/channels")).json()).toHaveLength(1);
      expect((await call(app, admin, "GET", "/api/alerts/rules")).json()).toHaveLength(1);
      expect((await call(app, admin, "GET", "/api/alerts/log")).json()).toHaveLength(1);

      const res = await call(app, admin, "POST", "/api/alerts/rules", {
        event: "backup_failed",
        channelId: chA.id,
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("rules", () => {
    it("creates, lists and deletes a rule", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const ch = await addChannel(app, s);
      const rule = await call(app, s, "POST", "/api/alerts/rules", {
        event: "deploy_failed",
        channelId: ch.id,
      });
      expect(rule.statusCode).toBe(201);
      expect(rule.json()).toMatchObject({ event: "deploy_failed", channelId: ch.id, threshold: null });

      expect((await call(app, s, "GET", "/api/alerts/rules")).json()).toHaveLength(1);
      const del = await call(app, s, "DELETE", `/api/alerts/rules/${rule.json().id}`);
      expect(del.statusCode).toBe(204);
      expect((await call(app, s, "GET", "/api/alerts/rules")).json()).toHaveLength(0);
    });

    it("validates event, channel and threshold", async () => {
      const app = await getApp();
      const s = await login(app, "admin@forja.dev");
      const ch = await addChannel(app, s);

      const bad = (payload: object) => call(app, s, "POST", "/api/alerts/rules", payload);
      expect((await bad({ event: "nope", channelId: ch.id })).statusCode).toBe(400);
      expect((await bad({ event: "site_down", channelId: "1" })).statusCode).toBe(400);
      expect((await bad({ event: "site_down", channelId: 9999 })).statusCode).toBe(404);
      expect((await bad({ event: "site_down", channelId: ch.id, threshold: { percent: 50 } })).statusCode).toBe(400);
      expect((await bad({ event: "disk_high", channelId: ch.id, threshold: { percent: 0 } })).statusCode).toBe(400);
      expect((await bad({ event: "disk_high", channelId: ch.id, threshold: { percent: 101 } })).statusCode).toBe(400);
      expect((await bad({ event: "disk_high", channelId: ch.id, threshold: { percent: "80" } })).statusCode).toBe(400);

      const ok = await bad({ event: "disk_high", channelId: ch.id, threshold: { percent: 80 } });
      expect(ok.statusCode).toBe(201);
      expect(ok.json().threshold).toEqual({ percent: 80 });
    });

    it("rejects duplicate rules", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const ch = await addChannel(app, s);
      await addRule(app, s, "site_down", ch.id);
      const res = await call(app, s, "POST", "/api/alerts/rules", { event: "site_down", channelId: ch.id });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("fireAlert", () => {
    it("stores a queued row in alert_log for a matching rule", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const ch = await addChannel(app, s);
      await addRule(app, s, "deploy_failed", ch.id);

      const result = fireAlert("deploy_failed", { accountId: 1, message: "Deploy failed for acct1.example.com" });
      expect(result.queued).toBe(1);

      const rows = db.select().from(schema.alertLog).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        channelId: ch.id,
        event: "deploy_failed",
        message: "Deploy failed for acct1.example.com",
        status: "queued",
      });

      const log = await call(app, s, "GET", "/api/alerts/log");
      expect(log.json()[0]).toMatchObject({ event: "deploy_failed", status: "queued" });
    });

    it("does nothing without a matching rule or for a different event", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const ch = await addChannel(app, s);
      await addRule(app, s, "deploy_failed", ch.id);

      expect(fireAlert("backup_failed", { accountId: 1, message: "x" }).queued).toBe(0);
      expect(db.select().from(schema.alertLog).all()).toHaveLength(0);
    });

    it("client rules only match events of their own accounts", async () => {
      const app = await getApp();
      const a = await login(app, "a@forja.dev");
      const chA = await addChannel(app, a);
      await addRule(app, a, "backup_failed", chA.id);

      expect(fireAlert("backup_failed", { accountId: 2, message: "other account" }).queued).toBe(0);
      expect(fireAlert("backup_failed", { message: "no account" }).queued).toBe(0);
      expect(fireAlert("backup_failed", { accountId: 1, message: "own account" }).queued).toBe(1);
    });

    it("admin rules match events of any account and host-level events", async () => {
      const app = await getApp();
      const admin = await login(app, "admin@forja.dev");
      const ch = await addChannel(app, admin);
      await addRule(app, admin, "backup_failed", ch.id);
      await addRule(app, admin, "ram_high", ch.id);

      expect(fireAlert("backup_failed", { accountId: 2, message: "x" }).queued).toBe(1);
      expect(fireAlert("ram_high", { message: "RAM", value: 95 }).queued).toBe(1);
    });

    it("applies thresholds (default 90%)", async () => {
      const app = await getApp();
      const admin = await login(app, "admin@forja.dev");
      const chDefault = await addChannel(app, admin, "default@example.com");
      const chCustom = await addChannel(app, admin, "custom@example.com");
      await addRule(app, admin, "disk_high", chDefault.id);
      await addRule(app, admin, "disk_high", chCustom.id, { threshold: { percent: 70 } });

      expect(fireAlert("disk_high", { message: "d", value: 60 }).queued).toBe(0);
      expect(fireAlert("disk_high", { message: "d", value: 75 }).queued).toBe(1);
      expect(fireAlert("disk_high", { message: "d", value: 95 }).queued).toBe(2);
      expect(fireAlert("disk_high", { message: "d" }).queued).toBe(0);
    });

    it("skips disabled channels and disabled users", async () => {
      const app = await getApp();
      const a = await login(app, "a@forja.dev");
      const ch = await addChannel(app, a);
      await addRule(app, a, "site_down", ch.id);

      await call(app, a, "PATCH", `/api/alerts/channels/${ch.id}`, { enabled: false });
      expect(fireAlert("site_down", { accountId: 1, message: "x" }).queued).toBe(0);

      await call(app, a, "PATCH", `/api/alerts/channels/${ch.id}`, { enabled: true });
      expect(fireAlert("site_down", { accountId: 1, message: "x" }).queued).toBe(1);

      db.update(schema.users).set({ disabled: true }).where(eq(schema.users.id, 2)).run();
      expect(fireAlert("site_down", { accountId: 1, message: "x" }).queued).toBe(0);
    });

    it("queues one row per channel even with several matching rules", async () => {
      const app = await getApp();
      const admin = await login(app, "admin@forja.dev");
      const ch = await addChannel(app, admin);
      await addRule(app, admin, "disk_high", ch.id);
      // A second user's rule on the same event goes to their own channel.
      const a = await login(app, "a@forja.dev");
      const chA = await addChannel(app, a, "a@example.com");
      await addRule(app, a, "disk_high", chA.id);

      expect(fireAlert("disk_high", { accountId: 1, message: "d", value: 99 }).queued).toBe(2);
    });

    it("never throws and never writes the address into the log", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const ch = await addChannel(app, s, "secret-address@example.com");
      await addRule(app, s, "site_down", ch.id);
      fireAlert("site_down", { accountId: 1, message: "Site acct1.example.com is down" });
      expect(JSON.stringify(db.select().from(schema.alertLog).all())).not.toContain("secret-address");

      vi.mocked(getDB).mockImplementation(() => {
        throw new Error("db unavailable");
      });
      expect(() => fireAlert("site_down", { accountId: 1, message: "x" })).not.toThrow();
    });
  });

  describe("GET /api/alerts/log", () => {
    it("validates and applies limit, newest first", async () => {
      const app = await getApp();
      const s = await login(app, "a@forja.dev");
      const ch = await addChannel(app, s);
      await addRule(app, s, "site_down", ch.id);
      for (let i = 1; i <= 3; i++) fireAlert("site_down", { accountId: 1, message: `m${i}` });

      const res = await call(app, s, "GET", "/api/alerts/log?limit=2");
      expect(res.json().map((r: { message: string }) => r.message)).toEqual(["m3", "m2"]);
      expect((await call(app, s, "GET", "/api/alerts/log?limit=0")).statusCode).toBe(400);
      expect((await call(app, s, "GET", "/api/alerts/log?limit=abc")).statusCode).toBe(400);
    });
  });

  describe("triggers", () => {
    it("a failed backup fires backup_failed to the owner's rule only", async () => {
      const app = await getApp();
      const a = await login(app, "a@forja.dev");
      const b = await login(app, "b@forja.dev");
      const chA = await addChannel(app, a);
      const chB = await addChannel(app, b);
      await addRule(app, a, "backup_failed", chA.id);
      await addRule(app, b, "backup_failed", chB.id);

      mockCallAction.mockResolvedValue({
        ok: false,
        error: { code: "BACKUP_FAILED", message: "restic: repository password is hunter2" },
      });
      const res = await call(app, a, "POST", "/api/accounts/1/backups", { scope: "all" });
      expect(res.statusCode).toBe(502);

      const rows = db.select().from(schema.alertLog).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ channelId: chA.id, event: "backup_failed", status: "queued" });
      // Only the error code is used, never the raw agent message.
      expect(rows[0].message).toContain("BACKUP_FAILED");
      expect(rows[0].message).not.toContain("hunter2");
    });

    it("a successful backup fires nothing", async () => {
      const app = await getApp();
      const a = await login(app, "a@forja.dev");
      const chA = await addChannel(app, a);
      await addRule(app, a, "backup_failed", chA.id);
      mockCallAction.mockResolvedValue({
        ok: true,
        result: { restic_snapshot_id: "abc", size_bytes: 10 },
      });
      const res = await call(app, a, "POST", "/api/accounts/1/backups", { scope: "all" });
      expect(res.statusCode).toBe(201);
      expect(db.select().from(schema.alertLog).all()).toHaveLength(0);
    });

    it("a failed deploy fires deploy_failed", async () => {
      const app = await getApp();
      const a = await login(app, "a@forja.dev");
      const chA = await addChannel(app, a);
      await addRule(app, a, "deploy_failed", chA.id);

      db.update(schema.sites)
        .set({ repo: "https://github.com/acme/app.git", branch: "main", runtime: "node" })
        .where(eq(schema.sites.id, 1))
        .run();
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue({
          ok: true,
          status: 200,
          json: async () => ({ sha: "a".repeat(40) }),
          text: async () => "",
        }),
      );
      mockCallAction.mockResolvedValue({
        ok: false,
        error: { code: "BUILD_FAILED", message: "npm ci failed: token=ghp_secret" },
      });

      const res = await call(app, a, "POST", "/api/sites/1/deploy");
      vi.unstubAllGlobals();
      expect(res.statusCode).toBe(502);

      const rows = db.select().from(schema.alertLog).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ event: "deploy_failed", status: "queued" });
      expect(rows[0].message).toContain("acct1.example.com");
      expect(rows[0].message).not.toContain("ghp_secret");
    });
  });
});
