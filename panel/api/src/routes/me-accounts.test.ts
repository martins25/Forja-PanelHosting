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

describe("GET /api/me/accounts", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

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
      ["client@forja.dev", "client"],
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
    }
    // The client is assigned to account 1 only.
    db.insert(schema.userAccounts).values({ userId: 2, accountId: 1 }).run();
  });

  afterEach(() => {
    sqlite.close();
    clearAppKey();
    clearVerifierForTest();
    resetAccess();
    vi.restoreAllMocks();
  });

  async function getApp() {
    return buildApp({ agentClient: { callAction: vi.fn() } as never, skipRateLimit: true });
  }

  async function list(email?: string) {
    const app = await getApp();
    if (!email) return app.inject({ method: "GET", url: "/api/me/accounts" });
    setVerifierForTest(async () => ({ email, sub: "u" }));
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "cf-access-jwt-assertion": "token" },
      payload: { password: "password123" },
    });
    return app.inject({
      method: "GET",
      url: "/api/me/accounts",
      headers: { cookie: res.headers["set-cookie"] as string },
    });
  }

  it("requires a session", async () => {
    expect((await list()).statusCode).toBe(401);
  });

  it("a client only sees their assigned accounts, without internal fields", async () => {
    const res = await list("client@forja.dev");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([{ id: 1, slug: "acct1", status: "active" }]);
  });

  it("a client with no assignments gets an empty list", async () => {
    db.delete(schema.userAccounts).run();
    const res = await list("client@forja.dev");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("an admin sees every account", async () => {
    const res = await list("admin@forja.dev");
    expect(res.statusCode).toBe(200);
    expect(res.json().map((a: { slug: string }) => a.slug)).toEqual(["acct1", "acct2"]);
  });
});
