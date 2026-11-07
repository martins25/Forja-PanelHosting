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
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

let sqlite: InstanceType<typeof Database>;

describe("env var routes", () => {
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

  async function adminLogin(app: Awaited<ReturnType<typeof getApp>>) {
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: {
        "cf-access-jwt-assertion": "valid-token",
      },
      payload: { email: "admin@forja.dev", password: "password123" },
    });
    const cookies = loginRes.headers["set-cookie"];
    const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : cookies ?? "";
    const csrfToken = loginRes.json().csrfToken;
    return { cookie: cookieStr, csrfToken };
  }

  it("creates an env var", async () => {
    const app = await getApp();
    const { cookie, csrfToken } = await adminLogin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/sites/1/env",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { key: "DB_HOST", value: "localhost" },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toBe("DB_HOST");
    expect(body.maskedValue).toBe("****host");
    expect(body.siteId).toBe(1);
    expect(body.id).toBeDefined();

    // Value should be encrypted in DB
    const row = db.select().from(schema.envVars).all()[0];
    expect(row.valueEnc).not.toBe("localhost");
    expect(decryptSecret(row.valueEnc)).toBe("localhost");
  });

  it("lists env vars with masked values", async () => {
    const app = await getApp();
    const { cookie, csrfToken } = await adminLogin(app);

    await app.inject({
      method: "POST",
      url: "/api/sites/1/env",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { key: "DB_HOST", value: "localhost" },
    });
    await app.inject({
      method: "POST",
      url: "/api/sites/1/env",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { key: "API_KEY", value: "secret12345" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/api/sites/1/env",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const vars = res.json();
    expect(vars).toHaveLength(2);
    expect(vars[0].key).toBe("DB_HOST");
    expect(vars[0].maskedValue).toBe("****host");
    expect(vars[1].key).toBe("API_KEY");
    expect(vars[1].maskedValue).toBe("****2345");

    // Full value should never appear
    const raw = res.payload;
    expect(raw).not.toContain("localhost");
    expect(raw).not.toContain("secret12345");
  });

  it("updates an env var", async () => {
    const app = await getApp();
    const { cookie, csrfToken } = await adminLogin(app);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/sites/1/env",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { key: "DB_HOST", value: "localhost" },
    });
    const varId = createRes.json().id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/sites/1/env/${varId}`,
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { value: "db.example.com" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().maskedValue).toBe("****.com");

    const row = db.select().from(schema.envVars).all()[0];
    expect(decryptSecret(row.valueEnc)).toBe("db.example.com");
  });

  it("deletes an env var", async () => {
    const app = await getApp();
    const { cookie, csrfToken } = await adminLogin(app);

    const createRes = await app.inject({
      method: "POST",
      url: "/api/sites/1/env",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { key: "DB_HOST", value: "localhost" },
    });
    const varId = createRes.json().id;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/sites/1/env/${varId}`,
      headers: { cookie, "x-csrf-token": csrfToken },
    });

    expect(res.statusCode).toBe(204);
    const rows = db.select().from(schema.envVars).all();
    expect(rows).toHaveLength(0);
  });

  it("rejects duplicate key", async () => {
    const app = await getApp();
    const { cookie, csrfToken } = await adminLogin(app);

    await app.inject({
      method: "POST",
      url: "/api/sites/1/env",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { key: "DB_HOST", value: "localhost" },
    });

    const res = await app.inject({
      method: "POST",
      url: "/api/sites/1/env",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { key: "DB_HOST", value: "other" },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("DUPLICATE_KEY");
  });

  it("rejects invalid key format", async () => {
    const app = await getApp();
    const { cookie, csrfToken } = await adminLogin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/sites/1/env",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { key: "1INVALID", value: "val" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_KEY");
  });

  it("rejects value too long", async () => {
    const app = await getApp();
    const { cookie, csrfToken } = await adminLogin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/sites/1/env",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { key: "BIG", value: "x".repeat(8193) },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALUE_TOO_LONG");
  });

  it("returns 404 for non-existent site", async () => {
    const app = await getApp();
    const { cookie, csrfToken } = await adminLogin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/sites/999/env",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { key: "DB_HOST", value: "localhost" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 404 for var of another site", async () => {
    const app = await getApp();
    const { cookie, csrfToken } = await adminLogin(app);

    // Create a second site
    db.insert(schema.sites)
      .values({
        accountId: 1,
        primaryDomain: "other.com",
        runtime: "node",
        runtimeVersion: "22",
        internalPort: 10002,
        mode: "online",
      })
      .run();

    const createRes = await app.inject({
      method: "POST",
      url: "/api/sites/1/env",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { key: "DB_HOST", value: "localhost" },
    });
    const varId = createRes.json().id;

    // Try to access site 1's var from site 2
    const res = await app.inject({
      method: "PATCH",
      url: `/api/sites/2/env/${varId}`,
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { value: "hacked" },
    });

    expect(res.statusCode).toBe(404);
  });

  it("masks short values correctly", async () => {
    const app = await getApp();
    const { cookie, csrfToken } = await adminLogin(app);

    const res = await app.inject({
      method: "POST",
      url: "/api/sites/1/env",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { key: "SHORT", value: "ab" },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().maskedValue).toBe("****");
  });

  it("writes audit entries", async () => {
    const app = await getApp();
    const { cookie, csrfToken } = await adminLogin(app);

    await app.inject({
      method: "POST",
      url: "/api/sites/1/env",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { key: "DB_HOST", value: "localhost" },
    });

    const logs = db.select().from(schema.auditLog).all();
    const createEntry = logs.find((l) => l.action === "env_var.create");
    expect(createEntry).toBeDefined();
    expect(createEntry!.targetType).toBe("env_var");
  });

  it("requires auth", async () => {
    const app = await getApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/sites/1/env",
    });

    expect(res.statusCode).toBe(401);
  });
});
