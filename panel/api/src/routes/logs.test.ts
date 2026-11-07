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

describe("log routes", () => {
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

    mockCallAction = vi.fn();
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

  it("returns app logs", async () => {
    mockCallAction.mockResolvedValue({
      ok: true,
      result: { lines: ["line1", "line2", "line3"], source: "app", count: 3 },
    });

    const app = await getApp();
    const { cookie } = await adminLogin(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/sites/1/logs?source=app&lines=50",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lines).toHaveLength(3);
    expect(body.source).toBe("app");
    expect(body.count).toBe(3);

    expect(mockCallAction).toHaveBeenCalledWith("logs.tail", {
      account_slug: "demo",
      domain: "example.com",
      source: "app",
      lines: 50,
    });
  });

  it("returns build log for a deployment", async () => {
    const logPath = "/srv/forja/accounts/demo/sites/example.com/logs/deploy-20261101.log";
    db.insert(schema.deployments)
      .values({
        siteId: 1,
        commitSha: "abc1234",
        trigger: "manual",
        status: "succeeded",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        logPath,
      })
      .run();

    mockCallAction.mockResolvedValue({
      ok: true,
      result: { lines: ["=== build ===", "Done."], source: "build", count: 2 },
    });

    const app = await getApp();
    const { cookie } = await adminLogin(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/sites/1/deployments/1/log",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.lines).toHaveLength(2);
    expect(body.source).toBe("build");
    expect(body.deployId).toBe(1);

    expect(mockCallAction).toHaveBeenCalledWith("logs.tail", {
      account_slug: "demo",
      domain: "example.com",
      source: "build",
      lines: 200,
      log_path: logPath,
    });
  });

  it("rejects invalid source", async () => {
    const app = await getApp();
    const { cookie } = await adminLogin(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/sites/1/logs?source=invalid",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_SOURCE");
  });

  it("returns 404 for deployment without log", async () => {
    db.insert(schema.deployments)
      .values({
        siteId: 1,
        commitSha: "abc1234",
        trigger: "manual",
        status: "succeeded",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        logPath: null,
      })
      .run();

    const app = await getApp();
    const { cookie } = await adminLogin(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/sites/1/deployments/1/log",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NO_LOG");
  });

  it("returns 404 for deployment from another site", async () => {
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

    db.insert(schema.deployments)
      .values({
        siteId: 2,
        commitSha: "abc1234",
        trigger: "manual",
        status: "succeeded",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        logPath: "/some/path.log",
      })
      .run();

    const app = await getApp();
    const { cookie } = await adminLogin(app);

    const res = await app.inject({
      method: "GET",
      url: "/api/sites/1/deployments/1/log",
      headers: { cookie },
    });

    expect(res.statusCode).toBe(404);
  });

  it("requires auth", async () => {
    const app = await getApp();

    const res = await app.inject({
      method: "GET",
      url: "/api/sites/1/logs",
    });

    expect(res.statusCode).toBe(401);
  });
});
