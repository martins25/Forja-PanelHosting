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
import { eq } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

let sqlite: InstanceType<typeof Database>;

describe("database routes", () => {
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

    mockCallAction = vi.fn().mockResolvedValue({ ok: true, result: {} });
  });

  afterEach(() => {
    sqlite.close();
    clearAppKey();
    clearSecretKey();
    resetAccess();
    clearVerifierForTest();
    vi.restoreAllMocks();
  });

  type App = Awaited<ReturnType<typeof buildApp>>;

  async function login(app: App, email = "admin@forja.dev") {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: {
        "cf-access-jwt-assertion": "test-jwt",
      },
      payload: { email, password: "password123" },
    });
    const cookies = res.headers["set-cookie"];
    const cookieStr = Array.isArray(cookies) ? cookies.join("; ") : (cookies ?? "");
    const csrf = (res.json() as { csrfToken: string }).csrfToken;
    return { cookie: cookieStr, csrf };
  }

  async function clientLogin(app: App) {
    const hash = await hashPassword("password123");
    db.insert(schema.users)
      .values({
        email: "client@forja.dev",
        role: "client",
        passwordHash: hash,
        createdAt: new Date().toISOString(),
      })
      .run();
    setVerifierForTest(async () => ({ email: "client@forja.dev", sub: "u2" }));
    return login(app, "client@forja.dev");
  }

  function makeApp() {
    return buildApp({
      agentClient: { callAction: mockCallAction } as never,
      skipRateLimit: true,
    });
  }

  describe("GET /api/accounts/:accountId/databases", () => {
    it("returns empty list when no databases", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/1/databases",
        headers: { cookie: auth.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("returns databases for the account", async () => {
      const { encryptSecret } = await import("../crypto/secrets.js");
      db.insert(schema.databases)
        .values({
          accountId: 1,
          engine: "mariadb",
          name: "testdb",
          dbUser: "testuser",
          passwordEnc: encryptSecret("testpass123"),
        })
        .run();

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/1/databases",
        headers: { cookie: auth.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<Record<string, unknown>>;
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe("testdb");
      expect(body[0].engine).toBe("mariadb");
      expect(body[0]).not.toHaveProperty("passwordEnc");
    });

    it("returns 404 for non-existent account", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/999/databases",
        headers: { cookie: auth.cookie },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/accounts/:accountId/databases", () => {
    it("creates a database", async () => {
      mockCallAction.mockResolvedValue({
        ok: true,
        result: { engine: "mariadb", db_name: "newdb", container_name: "fj-demo-mariadb" },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { engine: "mariadb", name: "newdb", db_user: "newuser" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as Record<string, unknown>;
      expect(body.name).toBe("newdb");
      expect(body.engine).toBe("mariadb");
      expect(body.password).toBeDefined();
      expect(typeof body.password).toBe("string");
      expect(body).not.toHaveProperty("passwordEnc");

      expect(mockCallAction).toHaveBeenCalledWith("db.create", expect.objectContaining({
        account_slug: "demo",
        engine: "mariadb",
        db_name: "newdb",
        db_user: "newuser",
      }));
    });

    it("rejects invalid engine", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { engine: "sqlite", name: "newdb", db_user: "newuser" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects when database limit reached", async () => {
      for (let i = 0; i < 3; i++) {
        db.insert(schema.databases)
          .values({
            accountId: 1,
            engine: "mariadb",
            name: `db${i}`,
            dbUser: `user${i}`,
            passwordEnc: "enc",
          })
          .run();
      }

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { engine: "mariadb", name: "extra", db_user: "extra" },
      });
      expect(res.statusCode).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe("PLAN_LIMIT");
    });

    it("returns 502 when agent fails", async () => {
      mockCallAction.mockResolvedValue({
        ok: false,
        error: { code: "EXECUTE", message: "podman: Error: /srv/forja/accounts/demo/databases/postgres/data: permission denied (podman 4.9.3)" },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { engine: "postgres", name: "pgdb", db_user: "pguser" },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toEqual({ code: "EXECUTE", message: "Agent action failed" });
      expect(res.body).not.toContain("/srv/forja");
      expect(res.body).not.toContain("podman");
    });

    it("stores the engine root password encrypted and never returns it", async () => {
      const rootPassword = "ab".repeat(32);
      mockCallAction.mockResolvedValue({
        ok: true,
        result: { engine: "mariadb", db_name: "rootdb", container_name: "fj-demo-mariadb", root_password: rootPassword },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { engine: "mariadb", name: "rootdb", db_user: "rootuser" },
      });
      expect(res.statusCode).toBe(201);
      expect(res.body).not.toContain(rootPassword);
      expect(res.body).not.toContain("rootPasswordEnc");
      expect(res.body).not.toContain("root_password");

      const row = db.select().from(schema.databases).where(eq(schema.databases.name, "rootdb")).get();
      expect(row?.rootPasswordEnc).toBeTruthy();
      expect(row?.rootPasswordEnc).not.toContain(rootPassword);
      expect(decryptSecret(row!.rootPasswordEnc!)).toBe(rootPassword);
    });

    it("leaves rootPasswordEnc empty when the engine already existed", async () => {
      mockCallAction.mockResolvedValue({
        ok: true,
        result: { engine: "mariadb", db_name: "second", container_name: "fj-demo-mariadb" },
      });
      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { engine: "mariadb", name: "second", db_user: "seconduser" },
      });
      expect(res.statusCode).toBe(201);
      const row = db.select().from(schema.databases).where(eq(schema.databases.name, "second")).get();
      expect(row?.rootPasswordEnc).toBeNull();
    });
  });

  describe("DELETE /api/accounts/:accountId/databases/:dbId", () => {
    it("deletes a database", async () => {
      db.insert(schema.databases)
        .values({
          accountId: 1,
          engine: "mariadb",
          name: "delme",
          dbUser: "deluser",
          passwordEnc: "enc",
        })
        .run();

      mockCallAction.mockResolvedValue({ ok: true, result: { dropped: true } });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "DELETE",
        url: "/api/accounts/1/databases/1",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(204);

      const remaining = db.select().from(schema.databases).all();
      expect(remaining).toHaveLength(0);
    });

    it("returns 404 for wrong account", async () => {
      db.insert(schema.databases)
        .values({
          accountId: 1,
          engine: "mariadb",
          name: "mydb",
          dbUser: "myuser",
          passwordEnc: "enc",
        })
        .run();

      db.insert(schema.accounts)
        .values({
          slug: "other",
          linuxUser: "fj-other",
          uid: 1002,
          planId: 1,
          status: "active",
          createdAt: new Date().toISOString(),
        })
        .run();

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "DELETE",
        url: "/api/accounts/2/databases/1",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/accounts/:accountId/databases/:dbId/dump", () => {
    it("creates a dump", async () => {
      const { encryptSecret } = await import("../crypto/secrets.js");
      db.insert(schema.databases)
        .values({
          accountId: 1,
          engine: "mariadb",
          name: "dumpdb",
          dbUser: "dumpuser",
          passwordEnc: encryptSecret("secret123"),
        })
        .run();

      mockCallAction.mockResolvedValue({
        ok: true,
        result: { path: "/srv/forja/accounts/demo/backups/db-dumpdb-20261103.sql" },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases/1/dump",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(200);
      const dumpBody = res.json() as { path: string };
      expect(dumpBody.path).toMatch(/^db-dumpdb-.*\.sql$/);
      expect(dumpBody.path).not.toContain("/");
    });
  });

  describe("PATCH /api/accounts/:accountId/databases/:dbId/password", () => {
    it("changes password", async () => {
      const { encryptSecret } = await import("../crypto/secrets.js");
      db.insert(schema.databases)
        .values({
          accountId: 1,
          engine: "postgres",
          name: "passdb",
          dbUser: "passuser",
          passwordEnc: encryptSecret("oldpass"),
        })
        .run();

      mockCallAction.mockResolvedValue({ ok: true, result: { updated: true } });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "PATCH",
        url: "/api/accounts/1/databases/1/password",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { password: string; passwordLast4: string };
      expect(body.password).toBeDefined();
      expect(body.passwordLast4).toBe(body.password.slice(-4));
    });
  });

  describe("POST /api/accounts/:accountId/databases/:dbId/tool/start", () => {
    it("starts a web tool", async () => {
      const { encryptSecret } = await import("../crypto/secrets.js");
      db.insert(schema.databases)
        .values({
          accountId: 1,
          engine: "mariadb",
          name: "tooldb",
          dbUser: "tooluser",
          passwordEnc: encryptSecret("pass"),
        })
        .run();

      mockCallAction.mockResolvedValue({
        ok: true,
        result: { port: 20001, container_name: "fj-demo-phpmyadmin" },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases/1/tool/start",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { tool: "phpmyadmin" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { port: number; containerName: string };
      expect(body.port).toBe(20001);
    });

    it("rejects invalid tool", async () => {
      const { encryptSecret } = await import("../crypto/secrets.js");
      db.insert(schema.databases)
        .values({
          accountId: 1,
          engine: "mariadb",
          name: "tooldb",
          dbUser: "tooluser",
          passwordEnc: encryptSecret("pass"),
        })
        .run();

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases/1/tool/start",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { tool: "dbeaver" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/accounts/:accountId/databases/:dbId/tool/stop", () => {
    it("stops a running web tool", async () => {
      const { encryptSecret } = await import("../crypto/secrets.js");
      db.insert(schema.databases)
        .values({
          accountId: 1,
          engine: "mariadb",
          name: "stopdb",
          dbUser: "stopuser",
          passwordEnc: encryptSecret("pass"),
          webTool: "phpmyadmin",
        })
        .run();

      mockCallAction.mockResolvedValue({ ok: true, result: { stopped: true } });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases/1/tool/stop",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(204);
    });

    it("returns 409 when no tool running", async () => {
      const { encryptSecret } = await import("../crypto/secrets.js");
      db.insert(schema.databases)
        .values({
          accountId: 1,
          engine: "mariadb",
          name: "nonedb",
          dbUser: "noneuser",
          passwordEnc: encryptSecret("pass"),
          webTool: "none",
        })
        .run();

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/databases/1/tool/stop",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  describe("authorization", () => {
    it("a client cannot access database endpoints", async () => {
      const app = await makeApp();
      const client = await clientLogin(app);
      const h = { cookie: client.cookie, "x-csrf-token": client.csrf };

      const endpoints = [
        { method: "GET" as const, url: "/api/accounts/1/databases" },
        { method: "POST" as const, url: "/api/accounts/1/databases" },
        { method: "DELETE" as const, url: "/api/accounts/1/databases/1" },
        { method: "POST" as const, url: "/api/accounts/1/databases/1/dump" },
        { method: "PATCH" as const, url: "/api/accounts/1/databases/1/password" },
        { method: "POST" as const, url: "/api/accounts/1/databases/1/tool/start" },
        { method: "POST" as const, url: "/api/accounts/1/databases/1/tool/stop" },
      ];

      for (const ep of endpoints) {
        const res = await app.inject({
          method: ep.method,
          url: ep.url,
          headers: h,
          ...(ep.method !== "GET" ? { payload: {} } : {}),
        });
        expect(res.statusCode, `${ep.method} ${ep.url}`).toBe(403);
      }
    });
  });
});
