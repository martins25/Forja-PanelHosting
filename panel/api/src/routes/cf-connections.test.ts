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
import {
  setSecretKeyForTest,
  clearSecretKey,
  decryptSecret,
} from "../crypto/secrets.js";
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

const TUNNEL_ID = "6ff42ae2-765d-4adf-8112-31c55c1551ef";
const CF_ACCOUNT = "a1".repeat(16);
const API_TOKEN = "cfapitoken_SECRETVALUE_wxyz";
const TUNNEL_TOKEN = Buffer.from(
  JSON.stringify({ a: CF_ACCOUNT, t: TUNNEL_ID, s: "c2VjcmV0c2VjcmV0" }),
).toString("base64");

const validBody = {
  name: "Cuenta principal",
  cf_account_id: CF_ACCOUNT,
  api_token: API_TOKEN,
  tunnel_id: TUNNEL_ID,
  tunnel_token: TUNNEL_TOKEN,
};

let sqlite: InstanceType<typeof Database>;

describe("cf-connections routes", () => {
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

    configureAccess({ teamDomain: "test.cloudflareaccess.com", audience: "test-aud" });
    setVerifierForTest(async () => ({ email: "admin@forja.dev", sub: "u1" }));

    db.insert(schema.users)
      .values({
        email: "admin@forja.dev",
        role: "admin",
        passwordHash: await hashPassword("password123"),
        createdAt: new Date().toISOString(),
      })
      .run();
    db.insert(schema.plans)
      .values({ name: "Basic", cpuMillis: 1000, memoryMb: 512, diskMb: 5000, maxSites: 5, maxDatabases: 3 })
      .run();
    for (const [i, slug] of ["demo", "otra"].entries()) {
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
    }
    db.insert(schema.sites)
      .values({
        accountId: 1,
        primaryDomain: "example.com",
        runtime: "node",
        runtimeVersion: "22",
        source: "github",
        repo: "https://github.com/user/repo",
        branch: "main",
        installCmd: "npm ci",
        startCmd: "npm start",
        internalPort: 10000,
        mode: "online",
      })
      .run();
    db.insert(schema.domains)
      .values([
        { siteId: 1, hostname: "example.com", kind: "primary" },
        { siteId: 1, hostname: "www.example.com", kind: "alias" },
      ])
      .run();

    mockCallAction = vi.fn().mockResolvedValue({ ok: true, result: {} });
  });

  afterEach(() => {
    sqlite.close();
    clearAppKey();
    clearSecretKey();
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

  type App = Awaited<ReturnType<typeof getApp>>;

  async function login(app: App, email = "admin@forja.dev") {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "cf-access-jwt-assertion": "valid-token" },
      payload: { email, password: "password123" },
    });
    const cookies = res.headers["set-cookie"];
    return {
      cookie: Array.isArray(cookies) ? cookies.join("; ") : (cookies ?? ""),
      csrf: res.json().csrfToken as string,
    };
  }

  async function clientLogin(app: App) {
    db.insert(schema.users)
      .values({
        email: "client@forja.dev",
        role: "client",
        passwordHash: await hashPassword("password123"),
        createdAt: new Date().toISOString(),
      })
      .run();
    setVerifierForTest(async () => ({ email: "client@forja.dev", sub: "u2" }));
    return login(app, "client@forja.dev");
  }

  async function create(app: App, auth: { cookie: string; csrf: string }, body = validBody) {
    return app.inject({
      method: "POST",
      url: "/api/cf-connections",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: body,
    });
  }

  function post(app: App, auth: { cookie: string; csrf: string }, url: string, payload?: unknown) {
    return app.inject({ method: "POST", url, headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf }, payload: payload as never });
  }

  describe("create / read", () => {
    it("creates a connection, encrypts tokens and exposes only the last 4 chars", async () => {
      const app = await getApp();
      const auth = await login(app);
      const res = await create(app, auth);

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.name).toBe("Cuenta principal");
      expect(body.tunnelId).toBe(TUNNEL_ID);
      expect(body.status).toBe("pending");
      expect(body.apiTokenLast4).toBe(API_TOKEN.slice(-4));
      expect(body.tunnelTokenLast4).toBe(TUNNEL_TOKEN.slice(-4));
      expect(body.apiTokenEnc).toBeUndefined();
      expect(body.tunnelTokenEnc).toBeUndefined();
      expect(res.payload).not.toContain(API_TOKEN);
      expect(res.payload).not.toContain(TUNNEL_TOKEN);

      const row = db.select().from(schema.cfConnections).all()[0];
      expect(row.apiTokenEnc).not.toContain(API_TOKEN);
      expect(decryptSecret(row.apiTokenEnc)).toBe(API_TOKEN);
      expect(decryptSecret(row.tunnelTokenEnc!)).toBe(TUNNEL_TOKEN);
    });

    it("never returns full tokens in list or detail", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);

      for (const url of ["/api/cf-connections", "/api/cf-connections/1"]) {
        const res = await app.inject({ method: "GET", url, headers: { cookie: auth.cookie } });
        expect(res.statusCode).toBe(200);
        expect(res.payload).not.toContain(API_TOKEN);
        expect(res.payload).not.toContain(TUNNEL_TOKEN);
        expect(res.payload).not.toContain("Enc");
      }
      const list = await app.inject({ method: "GET", url: "/api/cf-connections", headers: { cookie: auth.cookie } });
      expect(list.json()).toHaveLength(1);
    });

    it("returns 404 for an unknown connection", async () => {
      const app = await getApp();
      const auth = await login(app);
      const res = await app.inject({ method: "GET", url: "/api/cf-connections/99", headers: { cookie: auth.cookie } });
      expect(res.statusCode).toBe(404);
    });

    it("rejects invalid ids", async () => {
      const app = await getApp();
      const auth = await login(app);
      const res = await app.inject({ method: "GET", url: "/api/cf-connections/abc", headers: { cookie: auth.cookie } });
      expect(res.statusCode).toBe(400);
    });

    it.each([
      ["missing name", { name: "" }],
      ["bad account id", { cf_account_id: "../../x" }],
      ["bad api token", { api_token: "short" }],
      ["api token with newline", { api_token: API_TOKEN + "\nX-Evil: 1" }],
      ["bad tunnel id", { tunnel_id: "not-a-uuid" }],
      ["bad tunnel token", { tunnel_token: "--privileged" }],
    ])("rejects invalid body: %s", async (_label, patch) => {
      const app = await getApp();
      const auth = await login(app);
      const res = await create(app, auth, { ...validBody, ...patch });
      expect(res.statusCode).toBe(400);
      expect(res.payload).not.toContain(API_TOKEN);
    });

    it("rejects unknown fields", async () => {
      const app = await getApp();
      const auth = await login(app);
      const res = await create(app, auth, { ...validBody, managed_by: "client" } as never);
      expect(res.statusCode).toBe(400);
    });

    it("rejects a tunnel token that belongs to another tunnel", async () => {
      const app = await getApp();
      const auth = await login(app);
      const other = Buffer.from(JSON.stringify({ a: CF_ACCOUNT, t: "11111111-2222-3333-4444-555555555555", s: "x" })).toString("base64");
      const res = await create(app, auth, { ...validBody, tunnel_token: other });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("TUNNEL_MISMATCH");
    });

    it("rejects a duplicated tunnel", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      const res = await create(app, auth);
      expect(res.statusCode).toBe(409);
    });

    it("audits the creation without secrets", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      const entry = db.select().from(schema.auditLog).all().find((l) => l.action === "cf_connection.create");
      expect(entry?.result).toBe("ok");
      expect(entry?.targetId).toBe("1");
      expect(JSON.stringify(entry)).not.toContain(API_TOKEN);
    });
  });

  describe("authorization", () => {
    it("rejects unauthenticated requests", async () => {
      const app = await getApp();
      for (const [method, url] of [
        ["GET", "/api/cf-connections"],
        ["GET", "/api/cf-connections/1"],
        ["POST", "/api/cf-connections"],
        ["DELETE", "/api/cf-connections/1"],
        ["POST", "/api/cf-connections/1/apply"],
        ["POST", "/api/cf-connections/1/sync-routes"],
      ] as const) {
        const res = await app.inject({ method, url });
        expect(res.statusCode, `${method} ${url}`).toBe(401);
      }
    });

    it("a client can list connections (sees only own) but cannot access admin's or link/unlink accounts", async () => {
      const app = await getApp();
      const admin = await login(app);
      await create(app, admin);
      const client = await clientLogin(app);
      const h = { cookie: client.cookie, "x-csrf-token": client.csrf };

      // Client can list but sees empty (connection owned by admin)
      const listRes = await app.inject({ method: "GET", url: "/api/cf-connections", headers: h });
      expect(listRes.statusCode).toBe(200);
      expect(listRes.json()).toHaveLength(0);
      expect(listRes.payload).not.toContain(API_TOKEN);

      // Client cannot read/modify admin's connection
      const forbidden = [
        { method: "GET", url: "/api/cf-connections/1" },
        { method: "POST", url: "/api/cf-connections/1/apply" },
        { method: "POST", url: "/api/cf-connections/1/sync-routes" },
        { method: "DELETE", url: "/api/cf-connections/1" },
      ] as const;
      for (const a of forbidden) {
        const res = await app.inject({ method: a.method, url: a.url, headers: h });
        expect(res.statusCode, `${a.method} ${a.url}`).toBe(403);
        expect(res.payload).not.toContain(API_TOKEN);
      }

      // Link/unlink accounts is admin-only regardless
      const adminOnly = [
        { method: "POST", url: "/api/cf-connections/1/accounts", payload: { accountId: 1 } },
        { method: "DELETE", url: "/api/cf-connections/1/accounts/1" },
      ] as const;
      for (const a of adminOnly) {
        const res = await app.inject({ method: a.method, url: a.url, headers: h, payload: "payload" in a ? (a.payload as never) : undefined });
        expect(res.statusCode, `${a.method} ${a.url}`).toBe(403);
      }

      expect(db.select().from(schema.cfConnections).all()).toHaveLength(1);
    });

    it("requires a CSRF token on writes", async () => {
      const app = await getApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/cf-connections",
        headers: { cookie: auth.cookie },
        payload: validBody,
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("accounts linking", () => {
    it("links and unlinks an account", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);

      const link = await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });
      expect(link.statusCode).toBe(200);
      expect(link.json().accounts).toEqual([{ id: 1, slug: "demo" }]);

      const unlink = await app.inject({
        method: "DELETE",
        url: "/api/cf-connections/1/accounts/1",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(unlink.statusCode).toBe(200);
      expect(unlink.json().accounts).toEqual([]);
    });

    it("allows only one account per connection", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });

      const res = await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 2 });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("CONNECTION_HAS_ACCOUNT");
      expect(db.select().from(schema.accounts).all()[1].cfConnectionId).toBeNull();
    });

    it("refuses to move a connection to another account once the token was deployed", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });
      await post(app, auth, "/api/cf-connections/1/apply");
      await app.inject({
        method: "DELETE",
        url: "/api/cf-connections/1/accounts/1",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });

      const other = await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 2 });
      expect(other.statusCode).toBe(409);
      expect(other.json().error.code).toBe("TOKEN_EXPOSED");
      expect(db.select().from(schema.accounts).all()[1].cfConnectionId).toBeNull();

      // the same account may come back
      const same = await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });
      expect(same.statusCode).toBe(200);
    });

    it("records the host account even if the agent fails", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });
      mockCallAction.mockResolvedValue({ ok: false, error: { code: "EXECUTE", message: "x" } });
      await post(app, auth, "/api/cf-connections/1/apply");
      await app.inject({
        method: "DELETE",
        url: "/api/cf-connections/1/accounts/1",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      mockCallAction.mockResolvedValue({ ok: true, result: {} });

      const res = await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 2 });
      expect(res.statusCode).toBe(409);
    });

    it("does not expose the host account bookkeeping", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });
      const res = await post(app, auth, "/api/cf-connections/1/apply");
      expect(res.json().hostAccountId).toBeUndefined();
    });

    it("the database itself rejects two accounts on one connection", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });
      expect(() =>
        db.update(schema.accounts).set({ cfConnectionId: 1 }).where(eq(schema.accounts.id, 2)).run(),
      ).toThrow();
    });

    it("rejects linking an account that belongs to another connection", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      const second = Buffer.from(JSON.stringify({ a: CF_ACCOUNT, t: "11111111-2222-3333-4444-555555555555", s: "x" })).toString("base64");
      await create(app, auth, { ...validBody, tunnel_id: "11111111-2222-3333-4444-555555555555", tunnel_token: second });
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });

      const res = await post(app, auth, "/api/cf-connections/2/accounts", { accountId: 1 });
      expect(res.statusCode).toBe(409);
    });

    it("stops the container when the host account is unlinked", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });
      await post(app, auth, "/api/cf-connections/1/apply");
      mockCallAction.mockClear();

      const res = await app.inject({
        method: "DELETE",
        url: "/api/cf-connections/1/accounts/1",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(200);
      expect(mockCallAction).toHaveBeenCalledWith("cf.connection.apply", {
        account_slug: "demo",
        connection_id: 1,
        state: "absent",
      });
      expect(res.json().status).toBe("stopped");
    });

    it("keeps the link if the agent cannot stop the container", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });
      mockCallAction.mockResolvedValue({ ok: false, error: { code: "EXECUTE", message: "boom" } });

      const res = await app.inject({
        method: "DELETE",
        url: "/api/cf-connections/1/accounts/1",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(502);
      expect(db.select().from(schema.accounts).all()[0].cfConnectionId).toBe(1);
    });
  });

  describe("apply", () => {
    it("starts the container as the linked account with decrypted tokens", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });

      const res = await post(app, auth, "/api/cf-connections/1/apply");
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("running");
      expect(res.payload).not.toContain(TUNNEL_TOKEN);
      expect(mockCallAction).toHaveBeenCalledWith("cf.connection.apply", {
        account_slug: "demo",
        connection_id: 1,
        state: "present",
        tunnel_id: TUNNEL_ID,
        tunnel_token: TUNNEL_TOKEN,
      });
      const entry = db.select().from(schema.auditLog).all().find((l) => l.action === "cf_connection.apply");
      expect(entry?.result).toBe("ok");
    });

    it("returns 409 when no account is linked", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      const res = await post(app, auth, "/api/cf-connections/1/apply");
      expect(res.statusCode).toBe(409);
      expect(mockCallAction).not.toHaveBeenCalled();
    });

    it("never forwards internal agent details to the browser", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });
      mockCallAction.mockResolvedValue({
        ok: false,
        error: { code: "EXECUTE", message: "podman run failed: exit 125 (/srv/forja/cloudflared/1.env zone abc123)" },
      });

      for (const url of ["/api/cf-connections/1/apply", "/api/cf-connections/1/sync-routes"]) {
        const res = await post(app, auth, url);
        expect(res.statusCode).toBe(502);
        expect(res.json().error).toEqual({ code: "EXECUTE", message: "Agent action failed" });
        expect(res.payload).not.toContain("/srv/forja");
        expect(res.payload).not.toContain("podman");
      }

      mockCallAction.mockResolvedValue({ ok: false, error: { code: "SOMETHING_ODD", message: "secret path /etc/x" } });
      const odd = await post(app, auth, "/api/cf-connections/1/apply");
      expect(odd.json().error.code).toBe("AGENT_ERROR");
      expect(odd.payload).not.toContain("/etc/x");
    });

    it("maps agent errors without leaking tokens and marks the status", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });
      mockCallAction.mockResolvedValue({ ok: false, error: { code: "EXECUTE", message: "podman run failed" } });

      const res = await post(app, auth, "/api/cf-connections/1/apply");
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("EXECUTE");
      expect(res.payload).not.toContain(TUNNEL_TOKEN);
      expect(db.select().from(schema.cfConnections).all()[0].status).toBe("error");
      const entry = db.select().from(schema.auditLog).all().find((l) => l.action === "cf_connection.apply");
      expect(entry?.result).toBe("error");
    });

    it("handles an unreachable agent", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });
      mockCallAction.mockRejectedValue(new Error("connect ENOENT /run/forja/agent.sock"));

      const res = await post(app, auth, "/api/cf-connections/1/apply");
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("AGENT_UNREACHABLE");
      expect(res.payload).not.toContain("ENOENT");
    });

    it("404s for an unknown connection", async () => {
      const app = await getApp();
      const auth = await login(app);
      const res = await post(app, auth, "/api/cf-connections/9/apply");
      expect(res.statusCode).toBe(404);
    });
  });

  describe("sync-routes", () => {
    it("sends the domains of the linked accounts only", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      // account 2 owns a site but is NOT linked
      db.insert(schema.sites)
        .values({
          accountId: 2,
          primaryDomain: "ajena.com",
          runtime: "node",
          runtimeVersion: "22",
          source: "github",
          repo: "https://github.com/user/repo",
          branch: "main",
          installCmd: "npm ci",
          startCmd: "npm start",
          internalPort: 10002,
          mode: "online",
        })
        .run();
      db.insert(schema.domains).values({ siteId: 2, hostname: "ajena.com", kind: "primary" }).run();
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });

      mockCallAction.mockResolvedValue({
        ok: true,
        result: {
          domains: [
            { hostname: "example.com", status: "ok" },
            { hostname: "www.example.com", status: "ok" },
          ],
          failed: 0,
        },
      });
      const res = await post(app, auth, "/api/cf-connections/1/sync-routes");

      expect(res.statusCode).toBe(200);
      expect(res.json().failed).toBe(0);
      expect(res.payload).not.toContain(API_TOKEN);
      expect(mockCallAction).toHaveBeenCalledWith("cf.routes.sync", {
        connection_id: 1,
        cf_account_id: CF_ACCOUNT,
        tunnel_id: TUNNEL_ID,
        api_token: API_TOKEN,
        domains: ["example.com", "www.example.com"],
      });
    });

    it("reports partial failures and audits them", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });
      mockCallAction.mockResolvedValue({
        ok: true,
        result: {
          domains: [
            { hostname: "example.com", status: "ok" },
            { hostname: "www.example.com", status: "error", code: "ZONE_NOT_FOUND" },
          ],
          failed: 1,
        },
      });
      const res = await post(app, auth, "/api/cf-connections/1/sync-routes");
      expect(res.statusCode).toBe(200);
      expect(res.json().failed).toBe(1);
      const entry = db.select().from(schema.auditLog).all().find((l) => l.action === "cf_connection.sync_routes");
      expect(entry?.result).toBe("error");
      expect(entry?.errorCode).toBe("PARTIAL_SYNC");
    });

    it("maps agent failures to 502 without leaking the API token", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      mockCallAction.mockResolvedValue({ ok: false, error: { code: "EXECUTE", message: "update tunnel ingress: HTTP 403" } });
      const res = await post(app, auth, "/api/cf-connections/1/sync-routes");
      expect(res.statusCode).toBe(502);
      expect(res.payload).not.toContain(API_TOKEN);
    });

    it("404s for an unknown connection", async () => {
      const app = await getApp();
      const auth = await login(app);
      const res = await post(app, auth, "/api/cf-connections/9/sync-routes");
      expect(res.statusCode).toBe(404);
    });
  });

  describe("delete", () => {
    it("deletes a connection without accounts", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      const res = await app.inject({
        method: "DELETE",
        url: "/api/cf-connections/1",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(204);
      expect(db.select().from(schema.cfConnections).all()).toHaveLength(0);
      const entry = db.select().from(schema.auditLog).all().find((l) => l.action === "cf_connection.delete");
      expect(entry?.result).toBe("ok");
    });

    it("refuses while accounts are linked", async () => {
      const app = await getApp();
      const auth = await login(app);
      await create(app, auth);
      await post(app, auth, "/api/cf-connections/1/accounts", { accountId: 1 });
      const res = await app.inject({
        method: "DELETE",
        url: "/api/cf-connections/1",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(409);
      expect(db.select().from(schema.cfConnections).all()).toHaveLength(1);
    });

    it("404s for an unknown connection", async () => {
      const app = await getApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "DELETE",
        url: "/api/cf-connections/9",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
