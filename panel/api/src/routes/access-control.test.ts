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
import { setSecretKeyForTest, clearSecretKey, encryptSecret } from "../crypto/secrets.js";
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

describe("cross-account access control", () => {
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

    mockCallAction = vi.fn().mockResolvedValue({ ok: true, result: {} });
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ sha: "abc1234567890abc1234567890abc1234567890a" }),
    });

    const adminHash = await hashPassword("password123");
    const clientHash = await hashPassword("clientpass1");

    // admin (id 1)
    db.insert(schema.users).values({
      email: "admin@forja.dev",
      role: "admin",
      passwordHash: adminHash,
      createdAt: new Date().toISOString(),
    }).run();

    // client (id 2)
    db.insert(schema.users).values({
      email: "client@forja.dev",
      role: "client",
      passwordHash: clientHash,
      createdAt: new Date().toISOString(),
    }).run();

    db.insert(schema.plans).values({
      name: "Basic",
      cpuMillis: 1000,
      memoryMb: 512,
      diskMb: 5000,
      maxSites: 5,
      maxDatabases: 3,
    }).run();

    // Account 1 — assigned to client
    db.insert(schema.accounts).values({
      slug: "acct1",
      linuxUser: "fj-acct1",
      uid: 1001,
      planId: 1,
      status: "active",
      createdAt: new Date().toISOString(),
    }).run();

    // Account 2 — NOT assigned to client
    db.insert(schema.accounts).values({
      slug: "acct2",
      linuxUser: "fj-acct2",
      uid: 1002,
      planId: 1,
      status: "active",
      createdAt: new Date().toISOString(),
    }).run();

    // Assign client to account 1 only
    db.insert(schema.userAccounts).values({ userId: 2, accountId: 1 }).run();

    // Site in account 1
    db.insert(schema.sites).values({
      accountId: 1,
      primaryDomain: "site1.com",
      runtime: "node",
      source: "github",
      repo: "https://github.com/user/repo1",
      branch: "main",
      internalPort: 10000,
      webhookSecretEnc: encryptSecret("sec1"),
    }).run();

    // Site in account 2
    db.insert(schema.sites).values({
      accountId: 2,
      primaryDomain: "site2.com",
      runtime: "node",
      source: "github",
      repo: "https://github.com/user/repo2",
      branch: "main",
      internalPort: 10002,
      webhookSecretEnc: encryptSecret("sec2"),
    }).run();

    // Database in account 1
    db.insert(schema.databases).values({
      accountId: 1,
      engine: "postgres",
      name: "db1",
      dbUser: "u1",
      passwordEnc: encryptSecret("pass1"),
    }).run();

    // Database in account 2
    db.insert(schema.databases).values({
      accountId: 2,
      engine: "postgres",
      name: "db2",
      dbUser: "u2",
      passwordEnc: encryptSecret("pass2"),
    }).run();

    // Env var for site 1
    db.insert(schema.envVars).values({
      siteId: 1,
      key: "API_KEY",
      valueEnc: encryptSecret("val1"),
    }).run();

    // Env var for site 2
    db.insert(schema.envVars).values({
      siteId: 2,
      key: "API_KEY",
      valueEnc: encryptSecret("val2"),
    }).run();
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

  async function login(app: Awaited<ReturnType<typeof getApp>>, email: string, password: string) {
    setVerifierForTest(async () => ({ email, sub: email }));
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "cf-access-jwt-assertion": "token" },
      payload: { password },
    });
    const cookie = res.headers["set-cookie"] as string;
    const csrf = res.json().csrfToken;
    return { cookie, csrf };
  }

  // --- Sites ---

  it("client sees only sites from assigned account", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/sites",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const sites = res.json();
    expect(sites).toHaveLength(1);
    expect(sites[0].primaryDomain).toBe("site1.com");
  });

  it("client cannot get site from unassigned account", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/sites/2",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  it("client cannot create site in unassigned account", async () => {
    const app = await getApp();
    const { cookie, csrf } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "POST",
      url: "/api/sites",
      headers: { cookie, "x-csrf-token": csrf },
      payload: {
        accountId: 2,
        primaryDomain: "evil.com",
        runtime: "node",
        source: "github",
        repo: "https://github.com/user/evil",
        branch: "main",
      },
    });

    expect(res.statusCode).toBe(403);
  });

  it("client cannot deploy site from unassigned account", async () => {
    const app = await getApp();
    const { cookie, csrf } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "POST",
      url: "/api/sites/2/deploy",
      headers: { cookie, "x-csrf-token": csrf },
    });

    expect(res.statusCode).toBe(403);
  });

  // --- Databases ---

  it("client can list databases of assigned account", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/accounts/1/databases",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
  });

  it("client cannot list databases of unassigned account", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/accounts/2/databases",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  // --- Env vars ---

  it("client can list env vars for site in assigned account", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/sites/1/env",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
  });

  it("client cannot list env vars for site in unassigned account", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/sites/2/env",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  // --- Logs ---

  it("client cannot get logs for site in unassigned account", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/sites/2/logs",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  // --- Files ---

  it("client can list files in assigned account", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    mockCallAction.mockResolvedValueOnce({
      ok: true,
      result: { entries: [] },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/accounts/1/files?path=/",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
  });

  it("client cannot list files in unassigned account", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/accounts/2/files?path=/",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  // --- Backups ---

  it("client can list backups for assigned account", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/accounts/1/backups",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
  });

  it("client cannot list backups for unassigned account", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/accounts/2/backups",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  it("client cannot restore backups (admin only)", async () => {
    const app = await getApp();
    const { cookie, csrf } = await login(app, "client@forja.dev", "clientpass1");

    // Create a snapshot for account 1
    db.insert(schema.backups).values({
      accountId: 1,
      kind: "snapshot",
      resticSnapshotId: "snap123",
      includes: "all",
      status: "completed",
      createdAt: new Date().toISOString(),
    }).run();

    const res = await app.inject({
      method: "POST",
      url: "/api/accounts/1/backups/1/restore",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { target: "all", confirm: true },
    });

    expect(res.statusCode).toBe(403);
  });

  // --- Audit ---

  it("client sees only their own audit entries", async () => {
    const app = await getApp();

    // Create some audit entries
    db.insert(schema.auditLog).values({
      actorUserId: 1,
      actorKind: "user",
      action: "site.create",
      targetType: "site",
      targetId: "1",
      result: "ok",
      at: new Date().toISOString(),
    }).run();

    db.insert(schema.auditLog).values({
      actorUserId: 2,
      actorKind: "user",
      action: "site.deploy",
      targetType: "site",
      targetId: "1",
      result: "ok",
      at: new Date().toISOString(),
    }).run();

    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].actorUserId).toBe(2);
  });

  // --- Users / Invitations (admin only) ---

  it("client cannot list users", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/users",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  it("client cannot create users", async () => {
    const app = await getApp();
    const { cookie, csrf } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "POST",
      url: "/api/users",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { email: "new@forja.dev", password: "newpass123", role: "client" },
    });

    expect(res.statusCode).toBe(403);
  });

  it("client cannot list invitations", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/invitations",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  it("client cannot create invitations", async () => {
    const app = await getApp();
    const { cookie, csrf } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "POST",
      url: "/api/invitations",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { email: "new@forja.dev", role: "client" },
    });

    expect(res.statusCode).toBe(403);
  });

  // --- Accounts (admin only) ---

  it("client cannot list accounts", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/accounts",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  // --- Admin can see everything ---

  it("admin sees all sites", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "admin@forja.dev", "password123");

    const res = await app.inject({
      method: "GET",
      url: "/api/sites",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(2);
  });

  it("admin can access all databases", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "admin@forja.dev", "password123");

    const res = await app.inject({
      method: "GET",
      url: "/api/accounts/2/databases",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
  });

  // --- CF Connections ownership ---

  it("client cannot link accounts to connections (admin only)", async () => {
    const app = await getApp();

    // Create connection owned by client
    db.insert(schema.cfConnections).values({
      name: "my-tunnel",
      tunnelId: "t1",
      cfAccountId: "acct-tag",
      apiTokenEnc: encryptSecret("token1"),
      ownerUserId: 2,
      managedBy: "client",
    }).run();

    const { cookie, csrf } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "POST",
      url: "/api/cf-connections/1/accounts",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { accountId: 1 },
    });

    expect(res.statusCode).toBe(403);
  });

  it("client cannot see another user's CF connection", async () => {
    const app = await getApp();

    db.insert(schema.cfConnections).values({
      name: "admin-tunnel",
      tunnelId: "t2",
      cfAccountId: "acct-tag2",
      apiTokenEnc: encryptSecret("token2"),
      ownerUserId: 1,
      managedBy: "admin",
    }).run();

    const { cookie } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "GET",
      url: "/api/cf-connections/1",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(403);
  });

  // --- Mode restriction ---

  it("client cannot disable a site", async () => {
    const app = await getApp();
    const { cookie, csrf } = await login(app, "client@forja.dev", "clientpass1");

    const res = await app.inject({
      method: "PATCH",
      url: "/api/sites/1/mode",
      headers: { cookie, "x-csrf-token": csrf },
      payload: { mode: "disabled" },
    });

    expect(res.statusCode).toBe(403);
  });
});
