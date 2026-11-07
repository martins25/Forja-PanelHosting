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
import { setSecretKeyForTest, clearSecretKey, decryptSecret } from "../crypto/secrets.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { normalizeGiteaBaseUrl } from "./git-integrations.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

const TOKEN = "gitea_token_SECRETVALUE_wxyz";
const giteaBody = { provider: "gitea", baseUrl: "https://git.example.org", credentials: TOKEN };

let sqlite: InstanceType<typeof Database>;

describe("git-integrations routes", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

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
    return buildApp({ agentClient: { callAction: vi.fn() } as never, skipRateLimit: true });
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

  async function create(app: App, auth: { cookie: string; csrf: string }, body: object = giteaBody) {
    return app.inject({
      method: "POST",
      url: "/api/git-integrations",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: body,
    });
  }

  it("creates a Gitea integration, encrypts the token and never returns it", async () => {
    const app = await getApp();
    const auth = await login(app);
    const res = await create(app, auth);

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      id: 1,
      provider: "gitea",
      baseUrl: "https://git.example.org",
      credentialsLast4: TOKEN.slice(-4),
      sitesCount: 0,
    });
    expect(res.payload).not.toContain(TOKEN);

    const row = db.select().from(schema.gitIntegrations).get()!;
    expect(row.credentialsEnc).not.toContain(TOKEN);
    expect(decryptSecret(row.credentialsEnc)).toBe(TOKEN);

    const audit = db.select().from(schema.auditLog).all();
    expect(audit.map((a) => a.action)).toContain("git_integration.create");
    expect(JSON.stringify(audit)).not.toContain(TOKEN);
  });

  it("creates a GitHub integration without base URL", async () => {
    const app = await getApp();
    const auth = await login(app);
    const res = await create(app, auth, { provider: "github", credentials: "ghp_abcdefghijkl1234" });
    expect(res.statusCode).toBe(201);
    expect(res.json().baseUrl).toBeNull();
  });

  it("lists integrations without secrets", async () => {
    const app = await getApp();
    const auth = await login(app);
    await create(app, auth);
    const res = await app.inject({ method: "GET", url: "/api/git-integrations", headers: { cookie: auth.cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(1);
    expect(res.payload).not.toContain(TOKEN);
    expect(res.payload).not.toContain("credentialsEnc");
    expect(res.payload).not.toContain("webhookSecretEnc");
  });

  it("validates the body", async () => {
    const app = await getApp();
    const auth = await login(app);
    const bad: [object, string][] = [
      [{ ...giteaBody, provider: "gitlab" }, "INVALID_BODY"],
      [{ ...giteaBody, credentials: "short" }, "INVALID_BODY"],
      [{ ...giteaBody, extra: 1 }, "INVALID_BODY"],
      [{ provider: "gitea", credentials: TOKEN }, "INVALID_BASE_URL"],
      [{ ...giteaBody, baseUrl: "http://git.example.org" }, "INVALID_BASE_URL"],
      [{ ...giteaBody, baseUrl: "https://10.0.0.5:3000" }, "INVALID_BASE_URL"],
      [{ ...giteaBody, baseUrl: "https://user:pw@git.example.org" }, "INVALID_BASE_URL"],
      [{ ...giteaBody, baseUrl: "https://git.example.org/sub" }, "INVALID_BASE_URL"],
      [{ provider: "github", baseUrl: "https://git.example.org", credentials: TOKEN }, "INVALID_BODY"],
    ];
    for (const [body, code] of bad) {
      const res = await create(app, auth, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
      expect(res.json().error.code).toBe(code);
    }
    expect(db.select().from(schema.gitIntegrations).all()).toHaveLength(0);
  });

  it("rejects a duplicate Gitea instance", async () => {
    const app = await getApp();
    const auth = await login(app);
    await create(app, auth);
    const res = await create(app, auth, { ...giteaBody, baseUrl: "https://GIT.example.org/" });
    expect(res.statusCode).toBe(409);
  });

  it("deletes an integration and audits it", async () => {
    const app = await getApp();
    const auth = await login(app);
    await create(app, auth);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/git-integrations/1",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
    });
    expect(res.statusCode).toBe(204);
    expect(db.select().from(schema.gitIntegrations).all()).toHaveLength(0);
    expect(db.select().from(schema.auditLog).all().map((a) => a.action)).toContain("git_integration.delete");
  });

  it("refuses to delete an integration used by a site, and 404s unknown ids", async () => {
    const app = await getApp();
    const auth = await login(app);
    await create(app, auth);
    db.insert(schema.plans)
      .values({ name: "Basic", cpuMillis: 1000, memoryMb: 512, diskMb: 5000, maxSites: 5, maxDatabases: 3 })
      .run();
    db.insert(schema.accounts)
      .values({ slug: "demo", linuxUser: "fj-demo", uid: 1001, planId: 1, status: "active", createdAt: new Date().toISOString() })
      .run();
    db.insert(schema.sites)
      .values({
        accountId: 1,
        primaryDomain: "example.com",
        runtime: "node",
        source: "gitea",
        repo: "https://git.example.org/o/r.git",
        gitIntegrationId: 1,
        branch: "main",
      })
      .run();
    const h = { cookie: auth.cookie, "x-csrf-token": auth.csrf };
    const used = await app.inject({ method: "DELETE", url: "/api/git-integrations/1", headers: h });
    expect(used.statusCode).toBe(409);
    expect(db.select().from(schema.gitIntegrations).all()).toHaveLength(1);

    const missing = await app.inject({ method: "DELETE", url: "/api/git-integrations/99", headers: h });
    expect(missing.statusCode).toBe(404);
    const invalid = await app.inject({ method: "DELETE", url: "/api/git-integrations/abc", headers: h });
    expect(invalid.statusCode).toBe(400);
  });

  it("requires a session and a CSRF token", async () => {
    const app = await getApp();
    for (const [method, url] of [
      ["GET", "/api/git-integrations"],
      ["POST", "/api/git-integrations"],
      ["DELETE", "/api/git-integrations/1"],
    ] as const) {
      const res = await app.inject({ method, url });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    const auth = await login(app);
    const res = await app.inject({
      method: "POST",
      url: "/api/git-integrations",
      headers: { cookie: auth.cookie },
      payload: giteaBody,
    });
    expect(res.statusCode).toBe(403);
  });

  it("a client cannot see, create Gitea or delete integrations they do not own", async () => {
    const app = await getApp();
    const admin = await login(app);
    await create(app, admin);
    const client = await clientLogin(app);
    const h = { cookie: client.cookie, "x-csrf-token": client.csrf };

    const list = await app.inject({ method: "GET", url: "/api/git-integrations", headers: h });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([]);

    const attempts = [
      { method: "POST", url: "/api/git-integrations", payload: giteaBody },
      { method: "DELETE", url: "/api/git-integrations/1" },
    ] as const;
    for (const a of attempts) {
      const res = await app.inject({
        method: a.method,
        url: a.url,
        headers: h,
        payload: "payload" in a ? (a.payload as never) : undefined,
      });
      expect(res.statusCode, `${a.method} ${a.url}`).toBe(403);
      expect(res.payload).not.toContain(TOKEN);
    }
    expect(db.select().from(schema.gitIntegrations).all()).toHaveLength(1);
  });

  it("a client can manage their own GitHub integration only", async () => {
    const app = await getApp();
    const admin = await login(app);
    await create(app, admin);
    const client = await clientLogin(app);
    const h = { cookie: client.cookie, "x-csrf-token": client.csrf };

    const created = await create(app, client, { provider: "github", credentials: TOKEN });
    expect(created.statusCode).toBe(201);
    expect(created.payload).not.toContain(TOKEN);
    const mine = created.json().id as number;

    const list = await app.inject({ method: "GET", url: "/api/git-integrations", headers: h });
    expect(list.json().map((i: { id: number }) => i.id)).toEqual([mine]);

    const del = await app.inject({ method: "DELETE", url: `/api/git-integrations/${mine}`, headers: h });
    expect(del.statusCode).toBe(204);
    expect(db.select().from(schema.gitIntegrations).all()).toHaveLength(1);
  });

  describe("normalizeGiteaBaseUrl", () => {
    it("normalizes to the origin", () => {
      expect(normalizeGiteaBaseUrl("https://Git.Example.org/")).toBe("https://git.example.org");
      expect(normalizeGiteaBaseUrl("https://git.example.org:3000")).toBe("https://git.example.org:3000");
    });
    it("rejects non-public or malformed URLs", () => {
      for (const u of ["", "git.example.org", "https://localhost", "https://gitea.local", "https://192.168.1.1", "https://git.example.org?x=1", "https://git.example.org/#a"]) {
        expect(normalizeGiteaBaseUrl(u), u).toBeNull();
      }
    });
  });
});
