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

describe("backup remote routes", () => {
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


  const ACCESS = "AKIAIOSFODNN7EXAMPLE";
  const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

  const validBody = {
    name: "R2 principal",
    kind: "r2",
    endpoint: "https://abc123.r2.cloudflarestorage.com",
    bucket: "forja-backups",
    region: "auto",
    access_key: ACCESS,
    secret_key: SECRET,
  };

  async function create(app: App, auth: { cookie: string; csrf: string }, over: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: "/api/backup-remotes",
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: { ...validBody, ...over },
    });
  }

  function post(app: App, auth: { cookie: string; csrf: string }, url: string, payload: unknown = {}) {
    return app.inject({
      method: "POST",
      url,
      headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      payload: payload as never,
    });
  }

  describe("CRUD", () => {
    it("creates a remote, encrypts secrets and masks them in the response", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await create(app, auth);
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        id: 1,
        name: "R2 principal",
        kind: "r2",
        bucket: "forja-backups",
        enabled: true,
        accessKeyLast4: ACCESS.slice(-4),
        secretKeyLast4: SECRET.slice(-4),
      });
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain(ACCESS);
      expect(body.accessKeyEnc).toBeUndefined();

      const row = db.select().from(schema.backupRemotes).get()!;
      expect(row.accessKeyEnc).not.toContain(ACCESS);
      expect(row.secretKeyEnc).not.toContain(SECRET);
    });

    it("lists remotes without secrets", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      await create(app, auth, { name: "Otro" });
      const res = await app.inject({ method: "GET", url: "/api/backup-remotes", headers: { cookie: auth.cookie } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(2);
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain("Enc");
    });

    it.each([
      ["http endpoint", { endpoint: "http://s3.example.com" }],
      ["loopback endpoint", { endpoint: "https://127.0.0.1" }],
      ["localhost endpoint", { endpoint: "https://localhost" }],
      ["metadata endpoint", { endpoint: "https://169.254.169.254" }],
      ["endpoint with path", { endpoint: "https://s3.example.com/x" }],
      ["endpoint userinfo", { endpoint: "https://u:p@s3.example.com" }],
      ["bad kind", { kind: "gcs" }],
      ["bucket traversal", { bucket: "../x" }],
      ["bucket uppercase", { bucket: "Forja" }],
      ["bad region", { region: "eu west" }],
      ["access key newline", { access_key: "AKIAIOSFODNN7\nEXAMPLE" }],
      ["short secret", { secret_key: "abc" }],
      ["empty name", { name: "  " }],
      ["unknown field", { enabled_for: "all" }],
    ])("rejects %s", async (_n, over) => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await create(app, auth, over);
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(SECRET);
    });

    it("rejects creation without CSRF token", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await app.inject({
        method: "POST",
        url: "/api/backup-remotes",
        headers: { cookie: auth.cookie },
        payload: validBody,
      });
      expect(res.statusCode).toBe(403);
    });

    it("patches fields and re-encrypts replaced secrets", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      const newSecret = "newSecretKey0123456789abcdWXYZ";
      const res = await app.inject({
        method: "PATCH",
        url: "/api/backup-remotes/1",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { name: "Renombrado", enabled: false, secret_key: newSecret },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        name: "Renombrado",
        enabled: false,
        accessKeyLast4: ACCESS.slice(-4),
        secretKeyLast4: "WXYZ",
      });
      expect(res.body).not.toContain(newSecret);

      const audit = db.select().from(schema.auditLog).all().filter((a) => a.action === "backup_remote.update");
      expect(audit).toHaveLength(1);
      expect(audit[0].paramsRedacted).toBe("fields=name,secret_key,enabled");
      expect(JSON.stringify(audit)).not.toContain(newSecret);
    });

    it("rejects invalid patch and unknown ids", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      const bad = await app.inject({
        method: "PATCH",
        url: "/api/backup-remotes/1",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { endpoint: "https://10.0.0.1" },
      });
      expect(bad.statusCode).toBe(400);
      const missing = await app.inject({
        method: "PATCH",
        url: "/api/backup-remotes/99",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { name: "x" },
      });
      expect(missing.statusCode).toBe(404);
      const badId = await app.inject({
        method: "PATCH",
        url: "/api/backup-remotes/abc",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
        payload: { name: "x" },
      });
      expect(badId.statusCode).toBe(400);
    });

    it("deletes a remote", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      const res = await app.inject({
        method: "DELETE",
        url: "/api/backup-remotes/1",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(res.statusCode).toBe(204);
      expect(db.select().from(schema.backupRemotes).all()).toHaveLength(0);
      const again = await app.inject({
        method: "DELETE",
        url: "/api/backup-remotes/1",
        headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
      });
      expect(again.statusCode).toBe(404);
    });

    it("audits create without secret values", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      const rows = db.select().from(schema.auditLog).all();
      expect(rows.some((r) => r.action === "backup_remote.create" && r.result === "ok")).toBe(true);
      expect(JSON.stringify(rows)).not.toContain(SECRET);
    });
  });

  describe("POST /api/backup-remotes/:id/test", () => {
    it("calls the agent with decrypted credentials", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      mockCallAction.mockResolvedValue({ ok: true, result: { ok: true } });
      const res = await post(app, auth, "/api/backup-remotes/1/test");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(mockCallAction).toHaveBeenCalledWith("backup.test_remote", {
        remote_kind: "r2",
        endpoint: validBody.endpoint,
        bucket: "forja-backups",
        region: "auto",
        access_key: ACCESS,
        secret_key: SECRET,
      });
    });

    it("sanitizes agent failures", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      mockCallAction.mockResolvedValue({
        ok: false,
        error: { code: "EXECUTE", message: `restic: Access Denied ${SECRET} /var/lib/forja` },
      });
      const res = await post(app, auth, "/api/backup-remotes/1/test");
      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain(SECRET);
      expect(res.body).not.toContain("/var/lib");
      const audit = db.select().from(schema.auditLog).all().find((a) => a.action === "backup_remote.test");
      expect(audit?.result).toBe("error");
    });

    it("reports an unreachable agent", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      mockCallAction.mockRejectedValue(new Error("ECONNREFUSED"));
      const res = await post(app, auth, "/api/backup-remotes/1/test");
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("AGENT_UNREACHABLE");
    });

    it("404 for unknown remote", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const res = await post(app, auth, "/api/backup-remotes/9/test");
      expect(res.statusCode).toBe(404);
      expect(mockCallAction).not.toHaveBeenCalled();
    });
  });

  describe("POST /api/accounts/:accountId/backups/sync-remote", () => {
    it("syncs to the only enabled remote", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      mockCallAction.mockResolvedValue({ ok: true, result: { remote: "s3:x", snapshots_copied: 3 } });
      const res = await post(app, auth, "/api/accounts/1/backups/sync-remote");
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, snapshotsCopied: 3 });
      expect(mockCallAction).toHaveBeenCalledWith("backup.sync_remote", {
        account_slug: "demo",
        remote_kind: "r2",
        endpoint: validBody.endpoint,
        bucket: "forja-backups",
        region: "auto",
        access_key: ACCESS,
        secret_key: SECRET,
      });
      const audit = db.select().from(schema.auditLog).all().find((a) => a.action === "backup.sync_remote");
      expect(audit).toMatchObject({ result: "ok", targetId: "1", paramsRedacted: "remote_id=1" });
      expect(JSON.stringify(audit)).not.toContain(SECRET);
    });

    it("requires remote_id when several are enabled", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      await create(app, auth, { name: "Segundo" });
      const res = await post(app, auth, "/api/accounts/1/backups/sync-remote");
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("REMOTE_REQUIRED");

      mockCallAction.mockResolvedValue({ ok: true, result: { snapshots_copied: 0 } });
      const ok = await post(app, auth, "/api/accounts/1/backups/sync-remote", { remote_id: 2 });
      expect(ok.statusCode).toBe(200);
    });

    it("409 when no remote is configured or the chosen one is disabled", async () => {
      const app = await makeApp();
      const auth = await login(app);
      const none = await post(app, auth, "/api/accounts/1/backups/sync-remote");
      expect(none.statusCode).toBe(409);
      expect(none.json().error.code).toBe("NO_REMOTE");

      await create(app, auth, { enabled: false });
      const disabled = await post(app, auth, "/api/accounts/1/backups/sync-remote", { remote_id: 1 });
      expect(disabled.statusCode).toBe(409);
      expect(disabled.json().error.code).toBe("REMOTE_DISABLED");
      expect(mockCallAction).not.toHaveBeenCalled();
    });

    it("rejects bad bodies, unknown accounts and unknown remotes", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      expect((await post(app, auth, "/api/accounts/1/backups/sync-remote", { remote_id: "1; rm" })).statusCode).toBe(400);
      expect((await post(app, auth, "/api/accounts/1/backups/sync-remote", { extra: 1 })).statusCode).toBe(400);
      expect((await post(app, auth, "/api/accounts/99/backups/sync-remote")).statusCode).toBe(404);
      expect((await post(app, auth, "/api/accounts/abc/backups/sync-remote")).statusCode).toBe(400);
      expect((await post(app, auth, "/api/accounts/1/backups/sync-remote", { remote_id: 9 })).statusCode).toBe(404);
      expect(mockCallAction).not.toHaveBeenCalled();
    });

    it("sanitizes agent failures, audits and raises backup_failed", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      mockCallAction.mockResolvedValue({
        ok: false,
        error: { code: "EXECUTE", message: `boom ${SECRET}` },
      });
      const res = await post(app, auth, "/api/accounts/1/backups/sync-remote");
      expect(res.statusCode).toBe(502);
      expect(res.body).not.toContain(SECRET);
      const audit = db.select().from(schema.auditLog).all().find((a) => a.action === "backup.sync_remote");
      expect(audit?.result).toBe("error");
    });
  });

  describe("POST /api/accounts/:accountId/backups/restore-remote", () => {
    beforeEach(() => {
      db.insert(schema.backups)
        .values({
          accountId: 1,
          kind: "snapshot",
          resticSnapshotId: "abc12345",
          status: "completed",
          createdAt: "2024-01-01T00:00:00Z",
        })
        .run();
    });

    it("restores through the agent", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      mockCallAction.mockResolvedValue({ ok: true, result: { restored_to: "/srv/x", restarted: ["c1"] } });
      const res = await post(app, auth, "/api/accounts/1/backups/restore-remote", {
        backup_id: 1,
        target: "all",
        confirm: true,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, restored_to: "/srv/x", restarted: ["c1"] });
      expect(mockCallAction).toHaveBeenCalledWith(
        "backup.restore_remote",
        expect.objectContaining({
          account_slug: "demo",
          restic_snapshot_id: "abc12345",
          target: "all",
          confirm: true,
          secret_key: SECRET,
        }),
      );
    });

    it("requires confirm and a valid target", async () => {
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      const url = "/api/accounts/1/backups/restore-remote";
      expect((await post(app, auth, url, { backup_id: 1 })).statusCode).toBe(400);
      expect((await post(app, auth, url, { backup_id: 1, confirm: false })).statusCode).toBe(400);
      expect((await post(app, auth, url, { backup_id: 1, confirm: true, target: "site:../../etc" })).statusCode).toBe(400);
      expect(mockCallAction).not.toHaveBeenCalled();
    });

    it("does not restore a backup that belongs to another account", async () => {
      db.insert(schema.accounts)
        .values({ slug: "other", linuxUser: "fj-other", uid: 1002, planId: 1, status: "active", createdAt: new Date().toISOString() })
        .run();
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      const res = await post(app, auth, "/api/accounts/2/backups/restore-remote", { backup_id: 1, confirm: true });
      expect(res.statusCode).toBe(404);
      expect(mockCallAction).not.toHaveBeenCalled();
    });

    it("rejects export backups", async () => {
      db.insert(schema.backups)
        .values({ accountId: 1, kind: "export", status: "completed", createdAt: "2024-01-02T00:00:00Z" })
        .run();
      const app = await makeApp();
      const auth = await login(app);
      await create(app, auth);
      const res = await post(app, auth, "/api/accounts/1/backups/restore-remote", { backup_id: 2, confirm: true });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("NOT_RESTORABLE");
    });
  });

  describe("access control: clients never reach backup remotes", () => {
    it("rejects every endpoint for a client, even for an account assigned to them", async () => {
      const app = await makeApp();
      const admin = await login(app);
      await create(app, admin);
      const auth = await clientLogin(app);
      // Assign the account to the client so only the role check can stop them.
      db.insert(schema.userAccounts).values({ accountId: 1, userId: 2 }).run();
      mockCallAction.mockClear();

      const h = { cookie: auth.cookie, "x-csrf-token": auth.csrf };
      const calls: Array<[string, string, unknown?]> = [
        ["GET", "/api/backup-remotes"],
        ["POST", "/api/backup-remotes", validBody],
        ["PATCH", "/api/backup-remotes/1", { name: "x" }],
        ["DELETE", "/api/backup-remotes/1"],
        ["POST", "/api/backup-remotes/1/test", {}],
        ["POST", "/api/accounts/1/backups/sync-remote", {}],
        ["POST", "/api/accounts/1/backups/restore-remote", { backup_id: 1, confirm: true }],
      ];
      for (const [method, url, payload] of calls) {
        const res = await app.inject({ method: method as never, url, headers: h, payload: payload as never });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.body).not.toContain(SECRET);
      }
      expect(mockCallAction).not.toHaveBeenCalled();
      expect(db.select().from(schema.backupRemotes).all()).toHaveLength(1);
    });

    it("rejects unauthenticated requests", async () => {
      const app = await makeApp();
      const res = await app.inject({ method: "GET", url: "/api/backup-remotes" });
      expect(res.statusCode).toBe(401);
    });
  });
});
