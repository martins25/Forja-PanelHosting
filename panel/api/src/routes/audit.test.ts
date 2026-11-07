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
import { setSecretKeyForTest, clearSecretKey } from "../crypto/secrets.js";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { logAudit } from "../audit/log.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

let sqlite: InstanceType<typeof Database>;

describe("audit routes", () => {
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

    logAudit({
      actorUserId: 1,
      actorKind: "user",
      action: "site.create",
      targetType: "site",
      targetId: "1",
      result: "ok",
    });
    logAudit({
      actorUserId: 1,
      actorKind: "system",
      action: "site.deploy",
      targetType: "site",
      targetId: "1",
      result: "error",
      errorCode: "DEPLOY_FAILED",
    });
    logAudit({
      actorUserId: 1,
      actorKind: "user",
      action: "env_var.create",
      targetType: "env_var",
      targetId: "5",
      result: "ok",
    });
  });

  afterEach(() => {
    sqlite.close();
    clearAppKey();
    clearSecretKey();
    resetAccess();
    clearVerifierForTest();
    vi.restoreAllMocks();
  });

  async function loginAdmin() {
    const app = await buildApp({
      agentClient: { callAction: vi.fn() } as never,
      skipRateLimit: true,
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "password123" },
      headers: {
        "cf-access-jwt-assertion": "mock-token",
      },
    });
    const cookies = loginRes.headers["set-cookie"];
    const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : (cookies ?? "");
    return { app, cookies: cookieStr };
  }

  it("returns paginated audit entries", async () => {
    const { app, cookies } = await loginAdmin();
    const res = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie: cookies },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(3);
    expect(body.total).toBe(3);
    expect(body.page).toBe(1);
    expect(body.data[0].action).toBe("env_var.create");
    expect(body.data[0].actorEmail).toBe("admin@forja.dev");
  });

  it("filters by action", async () => {
    const { app, cookies } = await loginAdmin();
    const res = await app.inject({
      method: "GET",
      url: "/api/audit?action=site.deploy",
      headers: { cookie: cookies },
    });
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].action).toBe("site.deploy");
    expect(body.data[0].result).toBe("error");
  });

  it("filters by targetType", async () => {
    const { app, cookies } = await loginAdmin();
    const res = await app.inject({
      method: "GET",
      url: "/api/audit?targetType=env_var",
      headers: { cookie: cookies },
    });
    const body = res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].targetType).toBe("env_var");
  });

  it("paginates correctly", async () => {
    const { app, cookies } = await loginAdmin();
    const res = await app.inject({
      method: "GET",
      url: "/api/audit?page=1&limit=2",
      headers: { cookie: cookies },
    });
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.totalPages).toBe(2);

    const res2 = await app.inject({
      method: "GET",
      url: "/api/audit?page=2&limit=2",
      headers: { cookie: cookies },
    });
    const body2 = res2.json();
    expect(body2.data).toHaveLength(1);
  });

  it("rejects unauthenticated requests", async () => {
    const app = await buildApp({
      agentClient: { callAction: vi.fn() } as never,
      skipRateLimit: true,
    });
    const res = await app.inject({
      method: "GET",
      url: "/api/audit",
    });
    expect(res.statusCode).toBe(401);
  });

  it("client sees only own audit entries", async () => {
    const hash = await hashPassword("clientpass");
    db.insert(schema.users)
      .values({
        email: "client@forja.dev",
        role: "client",
        passwordHash: hash,
        createdAt: new Date().toISOString(),
      })
      .run();

    setVerifierForTest(async () => ({
      email: "client@forja.dev",
      sub: "u2",
    }));

    const app = await buildApp({
      agentClient: { callAction: vi.fn() } as never,
      skipRateLimit: true,
    });
    const loginRes = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { password: "clientpass" },
      headers: { "cf-access-jwt-assertion": "mock-token" },
    });
    const cookies = loginRes.headers["set-cookie"];
    const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : (cookies ?? "");

    const res = await app.inject({
      method: "GET",
      url: "/api/audit",
      headers: { cookie: cookieStr },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(0);
  });
});
