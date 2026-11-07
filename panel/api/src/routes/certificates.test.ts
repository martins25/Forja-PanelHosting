import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { encryptSecret, setSecretKeyForTest, clearSecretKey } from "../crypto/secrets.js";
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

describe("certificate routes", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let mockCallAction: ReturnType<typeof vi.fn>;
  const CF_TOKEN = "cf_token_ABCDEFGHIJKLMNOPQRSTUVWXYZ-0123";

  // Users: 1 admin, 2 client A (account 1), 3 client B (account 2).
  // Sites: 1 in account 1 (has a CF connection), 2 in account 2, 3 in account 3 (no CF connection).
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
      .values({ name: "Basic", cpuMillis: 1000, memoryMb: 512, diskMb: 5000, maxSites: 5, maxDatabases: 3 })
      .run();
    // One account per connection.
    for (const n of [1, 2]) {
      db.insert(schema.cfConnections)
        .values({ name: `cf${n}`, cfAccountId: "a".repeat(32), apiTokenEnc: encryptSecret(CF_TOKEN) })
        .run();
    }
    for (const [i, slug] of ["acct1", "acct2", "acct3"].entries()) {
      db.insert(schema.accounts)
        .values({
          slug,
          linuxUser: `fj-${slug}`,
          uid: 1001 + i,
          planId: 1,
          cfConnectionId: i < 2 ? i + 1 : null,
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
      db.insert(schema.domains)
        .values({ siteId: i + 1, hostname: `${slug}.example.com` })
        .run();
    }
    db.insert(schema.userAccounts).values({ userId: 2, accountId: 1 }).run();
    db.insert(schema.userAccounts).values({ userId: 3, accountId: 2 }).run();

    mockCallAction = vi.fn().mockResolvedValue({
      ok: true,
      result: { domain: "acct1.example.com", status: "pending" },
    });
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

  type S = { cookie: string; csrf: string };

  async function login(app: Awaited<ReturnType<typeof getApp>>, email: string): Promise<S> {
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

  function call(
    app: Awaited<ReturnType<typeof getApp>>,
    s: S,
    method: "GET" | "POST",
    siteId: number | string,
    suffix = "",
  ) {
    return app.inject({
      method,
      url: `/api/sites/${siteId}/certificate${suffix}`,
      headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
    });
  }

  it("requests a certificate: calls the agent with the account token and stores it", async () => {
    const app = await getApp();
    const a = await login(app, "a@forja.dev");
    const res = await call(app, a, "POST", 1);
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      siteId: 1,
      domain: "acct1.example.com",
      provider: "letsencrypt",
      status: "pending",
      autoRenew: true,
    });
    expect(mockCallAction).toHaveBeenCalledWith("cert.request", {
      account_slug: "acct1",
      domain: "acct1.example.com",
      cf_api_token: CF_TOKEN,
    });
    expect(JSON.stringify(res.json())).not.toContain(CF_TOKEN);

    const audit = db.select().from(schema.auditLog).all();
    expect(audit.some((e) => e.action === "certificate.request" && e.result === "ok")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(CF_TOKEN);
  });

  it("rejects a second request while one is pending or active", async () => {
    const app = await getApp();
    const a = await login(app, "a@forja.dev");
    expect((await call(app, a, "POST", 1)).statusCode).toBe(201);
    const again = await call(app, a, "POST", 1);
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe("CERTIFICATE_EXISTS");
  });

  it("requires a CSRF token on writes and a session on every endpoint", async () => {
    const app = await getApp();
    const a = await login(app, "a@forja.dev");
    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/sites/1/certificate",
      headers: { cookie: a.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    for (const [method, suffix] of [
      ["POST", ""],
      ["GET", ""],
      ["POST", "/renew"],
    ] as const) {
      const res = await app.inject({ method, url: `/api/sites/1/certificate${suffix}` });
      expect(res.statusCode).toBe(401);
    }
    expect(mockCallAction).not.toHaveBeenCalled();
  });

  it("reports the status and refreshes it from the agent", async () => {
    const app = await getApp();
    const a = await login(app, "a@forja.dev");
    expect((await call(app, a, "GET", 1)).statusCode).toBe(404);

    await call(app, a, "POST", 1);
    mockCallAction.mockResolvedValueOnce({
      ok: true,
      result: {
        domain: "acct1.example.com",
        status: "active",
        issued_at: "2026-11-01T00:00:00Z",
        expires_at: "2027-01-30T00:00:00Z",
      },
    });
    const res = await call(app, a, "GET", 1);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "active",
      issuedAt: "2026-11-01T00:00:00Z",
      expiresAt: "2027-01-30T00:00:00Z",
    });
    expect(mockCallAction).toHaveBeenLastCalledWith("cert.status", {
      account_slug: "acct1",
      domain: "acct1.example.com",
    });
    const dom = db.select().from(schema.domains).where(eq(schema.domains.siteId, 1)).get();
    expect(dom?.cert).toBe("letsencrypt");
    expect(dom?.certExpiresAt).toBe("2027-01-30T00:00:00Z");
  });

  it("GET falls back to the stored row when the agent is down", async () => {
    const app = await getApp();
    const a = await login(app, "a@forja.dev");
    await call(app, a, "POST", 1);
    mockCallAction.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const res = await call(app, a, "GET", 1);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("pending");
  });

  it("renews manually and returns the new state", async () => {
    const app = await getApp();
    const a = await login(app, "a@forja.dev");
    expect((await call(app, a, "POST", 1, "/renew")).statusCode).toBe(404);

    await call(app, a, "POST", 1);
    mockCallAction.mockResolvedValueOnce({
      ok: true,
      result: { domain: "acct1.example.com", status: "active", expires_at: "2027-02-01T00:00:00Z" },
    });
    const res = await call(app, a, "POST", 1, "/renew");
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "active", expiresAt: "2027-02-01T00:00:00Z" });
    expect(mockCallAction).toHaveBeenLastCalledWith("cert.renew", {
      account_slug: "acct1",
      domain: "acct1.example.com",
      cf_api_token: CF_TOKEN,
    });
  });

  it("marks the certificate as error and hides agent details when the agent fails", async () => {
    const app = await getApp();
    const a = await login(app, "a@forja.dev");
    mockCallAction.mockResolvedValueOnce({
      ok: false,
      error: { code: "EXECUTE", message: "open /var/lib/caddy/secret: denied" },
    });
    const res = await call(app, a, "POST", 1);
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.json())).not.toContain("/var/lib");
    const row = db.select().from(schema.certificates).get();
    expect(row?.status).toBe("error");

    // After an error the user can try again.
    const retry = await call(app, a, "POST", 1);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().status).toBe("pending");
  });

  it("needs a Cloudflare connection on the account", async () => {
    const app = await getApp();
    const admin = await login(app, "admin@forja.dev");
    const res = await call(app, admin, "POST", 3);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("NO_CF_CONNECTION");
    expect(mockCallAction).not.toHaveBeenCalled();
  });

  it("validates the site id and its existence", async () => {
    const app = await getApp();
    const admin = await login(app, "admin@forja.dev");
    expect((await call(app, admin, "GET", "abc")).statusCode).toBe(400);
    expect((await call(app, admin, "GET", 999)).statusCode).toBe(404);
  });

  describe("cross-account access", () => {
    it("a client cannot request, read or renew another account's certificate", async () => {
      const app = await getApp();
      const a = await login(app, "a@forja.dev");
      const b = await login(app, "b@forja.dev");
      expect((await call(app, a, "POST", 1)).statusCode).toBe(201);
      mockCallAction.mockClear();

      expect((await call(app, b, "POST", 1)).statusCode).toBe(403);
      expect((await call(app, b, "GET", 1)).statusCode).toBe(403);
      expect((await call(app, b, "POST", 1, "/renew")).statusCode).toBe(403);
      // Also when the other account has no certificate yet.
      expect((await call(app, a, "POST", 2)).statusCode).toBe(403);
      expect((await call(app, a, "GET", 2)).statusCode).toBe(403);
      expect((await call(app, a, "POST", 2, "/renew")).statusCode).toBe(403);

      expect(mockCallAction).not.toHaveBeenCalled();
      expect(db.select().from(schema.certificates).all()).toHaveLength(1);
    });

    it("an admin can manage any account's certificate", async () => {
      const app = await getApp();
      const admin = await login(app, "admin@forja.dev");
      expect((await call(app, admin, "POST", 2)).statusCode).toBe(201);
      expect((await call(app, admin, "GET", 2)).statusCode).toBe(200);
    });
  });
});
