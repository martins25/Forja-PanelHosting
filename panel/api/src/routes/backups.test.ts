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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

let sqlite: InstanceType<typeof Database>;

describe("backup routes", () => {
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

  describe("GET /api/accounts/:accountId/backups", () => {
    it("returns empty list", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/1/backups",
        headers: { cookie: auth.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("returns backups ordered by date desc", async () => {
      db.insert(schema.backups)
        .values({
          accountId: 1,
          kind: "snapshot",
          status: "completed",
          createdAt: "2024-01-01T00:00:00Z",
        })
        .run();
      db.insert(schema.backups)
        .values({
          accountId: 1,
          kind: "snapshot",
          status: "completed",
          createdAt: "2024-01-02T00:00:00Z",
        })
        .run();

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/1/backups",
        headers: { cookie: auth.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as Array<{ createdAt: string }>;
      expect(body).toHaveLength(2);
      expect(body[0].createdAt > body[1].createdAt).toBe(true);
    });

    it("rejects non-admin", async () => {
      const app = await makeApp();
      const auth = await clientLogin(app);
      const res = await app.inject({
        method: "GET",
        url: "/api/accounts/1/backups",
        headers: { cookie: auth.cookie },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/accounts/:accountId/backups", () => {
    it("creates a backup", async () => {
      mockCallAction.mockResolvedValue({
        ok: true,
        result: { restic_snapshot_id: "abc12345", size_bytes: 1024 },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/backups",
        headers: {
          cookie: auth.cookie,
          "x-csrf-token": auth.csrf,
        },
        payload: { scope: "all" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { kind: string; status: string; resticSnapshotId: string };
      expect(body.kind).toBe("snapshot");
      expect(body.status).toBe("completed");
      expect(body.resticSnapshotId).toBe("abc12345");
    });

    it("returns 502 on agent failure", async () => {
      mockCallAction.mockResolvedValue({
        ok: false,
        error: { code: "BACKUP_FAILED", message: "restic error" },
      });

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/backups",
        headers: {
          cookie: auth.cookie,
          "x-csrf-token": auth.csrf,
        },
        payload: { scope: "all" },
      });
      expect(res.statusCode).toBe(502);
    });

    it("rejects invalid scope", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/backups",
        headers: {
          cookie: auth.cookie,
          "x-csrf-token": auth.csrf,
        },
        payload: { scope: "invalid" },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe("POST /api/accounts/:accountId/backups/:backupId/restore", () => {
    it("requires confirm", async () => {
      db.insert(schema.backups)
        .values({
          accountId: 1,
          kind: "snapshot",
          resticSnapshotId: "abc12345",
          status: "completed",
          createdAt: new Date().toISOString(),
        })
        .run();

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/backups/1/restore",
        headers: {
          cookie: auth.cookie,
          "x-csrf-token": auth.csrf,
        },
        payload: { target: "all", confirm: false },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe("CONFIRM_REQUIRED");
    });

    it("restores with confirm", async () => {
      mockCallAction.mockResolvedValue({
        ok: true,
        result: { restored_to: "/srv/forja/accounts/demo", restarted: [] },
      });

      db.insert(schema.backups)
        .values({
          accountId: 1,
          kind: "snapshot",
          resticSnapshotId: "abc12345",
          status: "completed",
          createdAt: new Date().toISOString(),
        })
        .run();

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/backups/1/restore",
        headers: {
          cookie: auth.cookie,
          "x-csrf-token": auth.csrf,
        },
        payload: { target: "all", confirm: true },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    it("rejects export-type backup", async () => {
      db.insert(schema.backups)
        .values({
          accountId: 1,
          kind: "export",
          status: "completed",
          createdAt: new Date().toISOString(),
        })
        .run();

      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/backups/1/restore",
        headers: {
          cookie: auth.cookie,
          "x-csrf-token": auth.csrf,
        },
        payload: { target: "all", confirm: true },
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe("NOT_RESTORABLE");
    });

    it("rejects non-admin", async () => {
      db.insert(schema.backups)
        .values({
          accountId: 1,
          kind: "snapshot",
          resticSnapshotId: "abc12345",
          status: "completed",
          createdAt: new Date().toISOString(),
        })
        .run();

      const app = await makeApp();
      const auth = await clientLogin(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/accounts/1/backups/1/restore",
        headers: {
          cookie: auth.cookie,
          "x-csrf-token": auth.csrf,
        },
        payload: { target: "all", confirm: true },
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
