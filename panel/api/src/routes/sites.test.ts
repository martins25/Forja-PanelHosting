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

// Mock global fetch for GitHub API
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("site routes", () => {
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

    mockCallAction = vi.fn().mockImplementation(async (action: string) => {
      if (action === "site.create") {
        return {
          ok: true,
          result: {
            site_dir: "/srv/forja/accounts/demo/sites/example.com",
            port_blue: 10000,
            port_green: 10001,
          },
        };
      }
      if (action === "site.deploy") {
        return {
          ok: true,
          result: {
            container_name: "fj-demo-example-com-blue",
            image: "localhost/fj-demo-example-com:abc1234",
            commit_sha: "abc1234567890abc1234567890abc1234567890a",
            active_port: 10000,
          },
        };
      }
      if (action === "site.set_mode") {
        return { ok: true, result: { containers_stopped: 0, containers_started: 0 } };
      }
      if (action === "caddy.sync") {
        return { ok: true, result: { routes_loaded: 1 } };
      }
      return { ok: true, result: {} };
    });

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ sha: "abc1234567890abc1234567890abc1234567890a" }),
    });
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

  async function loginAdmin(app: Awaited<ReturnType<typeof getApp>>) {
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "cf-access-jwt-assertion": "token" },
      payload: { password: "password123" },
    });
    const cookie = res.headers["set-cookie"] as string;
    const csrf = res.json().csrfToken;
    return { cookie, csrf };
  }

  const validSiteBody = {
    accountId: 1,
    primaryDomain: "example.com",
    runtime: "node" as const,
    source: "github" as const,
    repo: "https://github.com/user/repo",
    branch: "main",
  };

  describe("POST /api/sites", () => {
    it("creates a site and triggers deploy", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validSiteBody,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.primaryDomain).toBe("example.com");
      expect(body.runtime).toBe("node");
      expect(body.internalPort).toBe(10000);
      expect(body.webhookUrl).toBe(`/hooks/github/${body.id}`);
      expect(body.webhookSecret).toHaveLength(64);
      expect(body.webhookSecretEnc).toBeUndefined();

      expect(mockCallAction).toHaveBeenCalledWith(
        "site.create",
        expect.objectContaining({
          account_slug: "demo",
          domain: "example.com",
          runtime: "node",
        }),
      );
      expect(mockCallAction).toHaveBeenCalledWith(
        "site.deploy",
        expect.objectContaining({
          account_slug: "demo",
          domain: "example.com",
          target_port: 10000,
        }),
      );
      expect(mockCallAction).toHaveBeenCalledWith(
        "caddy.sync",
        expect.objectContaining({ panel_port: 7000 }),
      );

      // Check domain was created
      const domainRows = db.select().from(schema.domains).all();
      expect(domainRows).toHaveLength(1);
      expect(domainRows[0].hostname).toBe("example.com");

      // Check deployment was recorded
      const deploys = db.select().from(schema.deployments).all();
      expect(deploys).toHaveLength(1);
      expect(deploys[0].status).toBe("succeeded");
    });

    it("rejects when account not found", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { ...validSiteBody, accountId: 999 },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("ACCOUNT_NOT_FOUND");
    });

    it("rejects when plan limit reached", async () => {
      // Set maxSites to 1
      db.update(schema.plans)
        .set({ maxSites: 1 })
        .run();

      // Insert one site already
      db.insert(schema.sites)
        .values({
          accountId: 1,
          primaryDomain: "existing.com",
          runtime: "node",
          mode: "online",
          internalPort: 10000,
        })
        .run();

      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validSiteBody,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("PLAN_LIMIT");
    });

    it("rejects duplicate domain", async () => {
      db.insert(schema.sites)
        .values({
          accountId: 1,
          primaryDomain: "example.com",
          runtime: "node",
          mode: "online",
          internalPort: 10000,
        })
        .run();

      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validSiteBody,
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe("DUPLICATE_DOMAIN");
    });

    it("returns 502 when site.create fails", async () => {
      mockCallAction.mockImplementation(async (action: string) => {
        if (action === "site.create") {
          return {
            ok: false,
            error: { code: "CREATE_FAILED", message: "mkdir /srv/forja/accounts/demo/sites: disk full" },
          };
        }
        return { ok: true, result: {} };
      });

      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validSiteBody,
      });

      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("AGENT_ERROR");
      expect(res.json().error.message).toBe("Agent action failed");
      expect(res.body).not.toContain("/srv/forja");
    });

    it("returns 502 when site.deploy fails", async () => {
      mockCallAction.mockImplementation(async (action: string) => {
        if (action === "site.create") {
          return { ok: true, result: { site_dir: "/tmp", port_blue: 10000, port_green: 10001 } };
        }
        if (action === "site.deploy") {
          return { ok: false, error: { code: "BUILD_FAILED", message: "Build error" } };
        }
        if (action === "caddy.sync") {
          return { ok: true, result: { routes_loaded: 1 } };
        }
        return { ok: true, result: {} };
      });

      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validSiteBody,
      });

      expect(res.statusCode).toBe(502);

      // Deploy should still be recorded as failed
      const deploys = db.select().from(schema.deployments).all();
      expect(deploys).toHaveLength(1);
      expect(deploys[0].status).toBe("failed");
    });

    it("writes audit on success", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validSiteBody,
      });

      const logs = db.select().from(schema.auditLog).all();
      const entry = logs.find((l) => l.action === "site.create" && l.result === "ok");
      expect(entry).toBeDefined();
    });

    it("assigns even ports starting from 10000", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validSiteBody,
      });

      const site = res.json();
      expect(site.internalPort % 2).toBe(0);
      expect(site.internalPort).toBeGreaterThanOrEqual(10000);
    });

    it("defaults to node 22 and npm commands", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: {
          accountId: 1,
          primaryDomain: "example.com",
          source: "github",
          repo: "https://github.com/user/repo",
        },
      });

      const deployCall = mockCallAction.mock.calls.find(
        (c: unknown[]) => c[0] === "site.deploy",
      );
      expect(deployCall).toBeDefined();
      expect(deployCall![1]).toMatchObject({
        runtime_version: "22",
        install_cmd: "npm ci",
        start_cmd: "npm start",
      });
    });

    it("rejects non-admin", async () => {
      db.insert(schema.users)
        .values({
          email: "client@forja.dev",
          role: "client",
          passwordHash: await hashPassword("password123"),
          createdAt: new Date().toISOString(),
        })
        .run();

      setVerifierForTest(async () => ({
        email: "client@forja.dev",
        sub: "u2",
      }));

      const app = await getApp();
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { password: "password123" },
      });

      const cookie = loginRes.headers["set-cookie"] as string;
      const csrf = loginRes.json().csrfToken;

      const res = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validSiteBody,
      });

      expect(res.statusCode).toBe(403);
    });
  });

  describe("POST /api/sites/:id/deploy", () => {
    async function createSite(app: Awaited<ReturnType<typeof getApp>>, cookie: string, csrf: string) {
      const res = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validSiteBody,
      });
      return res.json();
    }

    it("deploys with port alternation", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);
      const site = await createSite(app, cookie, csrf);

      mockCallAction.mockClear();
      mockCallAction.mockImplementation(async (action: string) => {
        if (action === "site.deploy") {
          return {
            ok: true,
            result: { container_name: "fj-demo-example-com-green", active_port: 10001 },
          };
        }
        if (action === "caddy.sync") {
          return { ok: true, result: { routes_loaded: 1 } };
        }
        return { ok: true, result: {} };
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/sites/${site.id}/deploy`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      expect(res.statusCode).toBe(200);

      const deployCall = mockCallAction.mock.calls.find(
        (c: unknown[]) => c[0] === "site.deploy",
      );
      expect(deployCall).toBeDefined();
      // Original port was 10000 (even/blue), so target should be 10001 (green)
      expect(deployCall![1]).toMatchObject({ target_port: 10001 });
    });

    it("passes old container name for zero-downtime", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);
      const site = await createSite(app, cookie, csrf);

      mockCallAction.mockClear();
      mockCallAction.mockImplementation(async (action: string) => {
        if (action === "site.deploy") {
          return {
            ok: true,
            result: { container_name: "fj-demo-example-com-green", active_port: 10001 },
          };
        }
        if (action === "caddy.sync") {
          return { ok: true, result: { routes_loaded: 1 } };
        }
        return { ok: true, result: {} };
      });

      await app.inject({
        method: "POST",
        url: `/api/sites/${site.id}/deploy`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      const deployCall = mockCallAction.mock.calls.find(
        (c: unknown[]) => c[0] === "site.deploy",
      );
      expect(deployCall![1].old_container).toBe("fj-demo-example-com-blue");
    });

    it("creates deployment record", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);
      const site = await createSite(app, cookie, csrf);

      // Clear deploy record from creation
      const beforeCount = db.select().from(schema.deployments).all().length;

      mockCallAction.mockClear();
      mockCallAction.mockImplementation(async (action: string) => {
        if (action === "site.deploy") {
          return { ok: true, result: { active_port: 10001 } };
        }
        if (action === "caddy.sync") {
          return { ok: true, result: {} };
        }
        return { ok: true, result: {} };
      });

      await app.inject({
        method: "POST",
        url: `/api/sites/${site.id}/deploy`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      const afterCount = db.select().from(schema.deployments).all().length;
      expect(afterCount).toBe(beforeCount + 1);
    });

    it("calls caddy.sync after deploy", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);
      const site = await createSite(app, cookie, csrf);

      mockCallAction.mockClear();
      mockCallAction.mockImplementation(async (action: string) => {
        if (action === "site.deploy") {
          return { ok: true, result: { active_port: 10001 } };
        }
        if (action === "caddy.sync") {
          return { ok: true, result: {} };
        }
        return { ok: true, result: {} };
      });

      await app.inject({
        method: "POST",
        url: `/api/sites/${site.id}/deploy`,
        headers: { cookie, "x-csrf-token": csrf },
      });

      const syncCall = mockCallAction.mock.calls.find(
        (c: unknown[]) => c[0] === "caddy.sync",
      );
      expect(syncCall).toBeDefined();
    });

    it("rejects for non-existent site", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "POST",
        url: "/api/sites/9999/deploy",
        headers: { cookie, "x-csrf-token": csrf },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /api/sites", () => {
    it("lists all sites", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validSiteBody,
      });

      const res = await app.inject({
        method: "GET",
        url: "/api/sites",
        headers: { cookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
      expect(res.json()[0].primaryDomain).toBe("example.com");
    });

    it("client sees only assigned account sites (empty when none assigned)", async () => {
      db.insert(schema.users)
        .values({
          email: "client@forja.dev",
          role: "client",
          passwordHash: await hashPassword("password123"),
          createdAt: new Date().toISOString(),
        })
        .run();

      setVerifierForTest(async () => ({
        email: "client@forja.dev",
        sub: "u2",
      }));

      const app = await getApp();
      const loginRes = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { password: "password123" },
      });

      const cookie = loginRes.headers["set-cookie"] as string;

      const res = await app.inject({
        method: "GET",
        url: "/api/sites",
        headers: { cookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(0);
    });
  });

  describe("GET /api/sites/:id", () => {
    it("returns site details", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const createRes = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validSiteBody,
      });
      const siteId = createRes.json().id;

      const res = await app.inject({
        method: "GET",
        url: `/api/sites/${siteId}`,
        headers: { cookie },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().primaryDomain).toBe("example.com");
    });

    it("returns 404 for non-existent site", async () => {
      const app = await getApp();
      const { cookie } = await loginAdmin(app);

      const res = await app.inject({
        method: "GET",
        url: "/api/sites/9999",
        headers: { cookie },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe("PATCH /api/sites/:id/mode", () => {
    async function createSiteForMode(app: Awaited<ReturnType<typeof getApp>>, cookie: string, csrf: string) {
      const res = await app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload: validSiteBody,
      });
      return res.json();
    }

    it("changes mode to maintenance", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);
      const site = await createSiteForMode(app, cookie, csrf);

      mockCallAction.mockClear();

      const res = await app.inject({
        method: "PATCH",
        url: `/api/sites/${site.id}/mode`,
        headers: { cookie, "x-csrf-token": csrf },
        payload: { mode: "maintenance", noticeTitle: "En obras" },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().mode).toBe("maintenance");
      expect(res.json().noticeTitle).toBe("En obras");

      // Should NOT call site.set_mode for maintenance (no container change)
      const setModeCall = mockCallAction.mock.calls.find(
        (c: unknown[]) => c[0] === "site.set_mode",
      );
      expect(setModeCall).toBeUndefined();

      // Should call caddy.sync
      const syncCall = mockCallAction.mock.calls.find(
        (c: unknown[]) => c[0] === "caddy.sync",
      );
      expect(syncCall).toBeDefined();
    });

    it("calls agent site.set_mode when switching to disabled", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);
      const site = await createSiteForMode(app, cookie, csrf);

      mockCallAction.mockClear();
      mockCallAction.mockImplementation(async (action: string) => {
        if (action === "site.set_mode") {
          return { ok: true, result: { containers_stopped: 1, containers_started: 0 } };
        }
        if (action === "caddy.sync") {
          return { ok: true, result: { routes_loaded: 1 } };
        }
        return { ok: true, result: {} };
      });

      const res = await app.inject({
        method: "PATCH",
        url: `/api/sites/${site.id}/mode`,
        headers: { cookie, "x-csrf-token": csrf },
        payload: { mode: "disabled" },
      });

      expect(res.statusCode).toBe(200);

      const setModeCall = mockCallAction.mock.calls.find(
        (c: unknown[]) => c[0] === "site.set_mode",
      );
      expect(setModeCall).toBeDefined();
      expect(setModeCall![1]).toMatchObject({
        account_slug: "demo",
        domain: "example.com",
        mode: "disabled",
      });
    });

    it("rejects invalid mode", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);
      const site = await createSiteForMode(app, cookie, csrf);

      const res = await app.inject({
        method: "PATCH",
        url: `/api/sites/${site.id}/mode`,
        headers: { cookie, "x-csrf-token": csrf },
        payload: { mode: "broken" },
      });

      expect(res.statusCode).toBe(400);
    });

    it("writes audit on mode change", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);
      const site = await createSiteForMode(app, cookie, csrf);

      await app.inject({
        method: "PATCH",
        url: `/api/sites/${site.id}/mode`,
        headers: { cookie, "x-csrf-token": csrf },
        payload: { mode: "maintenance" },
      });

      const logs = db.select().from(schema.auditLog).all();
      const entry = logs.find(
        (l) => l.action === "site.set_mode" && l.result === "ok",
      );
      expect(entry).toBeDefined();
    });

    it("returns 404 for non-existent site", async () => {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);

      const res = await app.inject({
        method: "PATCH",
        url: "/api/sites/9999/mode",
        headers: { cookie, "x-csrf-token": csrf },
        payload: { mode: "maintenance" },
      });

      expect(res.statusCode).toBe(404);
    });
  });
  describe("POST /api/sites with Gitea", () => {
    const giteaSha = "e".repeat(40);

    beforeEach(() => {
      db.insert(schema.gitIntegrations)
        .values([
          {
            provider: "gitea",
            baseUrl: "https://git.example.org",
            credentialsEnc: encryptSecret("gitea-token-1234"),
            webhookSecretEnc: encryptSecret("unused"),
          },
          {
            provider: "github",
            credentialsEnc: encryptSecret("ghp_token_12345678"),
            webhookSecretEnc: encryptSecret("unused"),
          },
        ])
        .run();
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ commit: { id: giteaSha } }),
      });
    });

    const giteaSiteBody = {
      ...validSiteBody,
      source: "gitea" as const,
      repo: "owner/repo",
      gitIntegrationId: 1,
    };

    async function post(payload: object) {
      const app = await getApp();
      const { cookie, csrf } = await loginAdmin(app);
      return app.inject({
        method: "POST",
        url: "/api/sites",
        headers: { cookie, "x-csrf-token": csrf },
        payload,
      });
    }

    it("builds the repo URL from the integration and deploys the Gitea commit", async () => {
      const res = await post(giteaSiteBody);

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.source).toBe("gitea");
      expect(body.repo).toBe("https://git.example.org/owner/repo.git");
      expect(body.gitIntegrationId).toBe(1);
      expect(body.webhookUrl).toBe(`/hooks/gitea/${body.id}`);
      expect(body.webhookSecret).toHaveLength(64);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://git.example.org/api/v1/repos/owner/repo/branches/main",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "token gitea-token-1234" }),
        }),
      );
      expect(mockCallAction).toHaveBeenCalledWith(
        "site.deploy",
        expect.objectContaining({
          repo: "https://git.example.org/owner/repo.git",
          commit: giteaSha,
        }),
      );
      const row = db.select().from(schema.sites).get()!;
      expect(row.source).toBe("gitea");
      expect(row.gitIntegrationId).toBe(1);
    });

    it("accepts a repo ending in .git", async () => {
      const res = await post({ ...giteaSiteBody, repo: "owner/repo.git" });
      expect(res.statusCode).toBe(201);
      expect(res.json().repo).toBe("https://git.example.org/owner/repo.git");
    });

    it("requires an existing Gitea integration", async () => {
      for (const gitIntegrationId of [undefined, 99, 2]) {
        const res = await post({ ...giteaSiteBody, gitIntegrationId });
        expect(res.statusCode, String(gitIntegrationId)).toBe(400);
        expect(res.json().error.code).toBe("INVALID_INTEGRATION");
      }
      expect(mockCallAction).not.toHaveBeenCalled();
      expect(db.select().from(schema.sites).all()).toHaveLength(0);
    });

    it("rejects repos that are not owner/repo", async () => {
      for (const repo of ["owner", "https://evil.example/owner/repo", "../repo", "owner/..", "a/b/c", "owner/re po"]) {
        const res = await post({ ...giteaSiteBody, repo });
        expect(res.statusCode, repo).toBe(400);
      }
      expect(mockCallAction).not.toHaveBeenCalled();
    });

    it("rejects gitIntegrationId on a GitHub site and unknown sources", async () => {
      const github = await post({ ...validSiteBody, gitIntegrationId: 1 });
      expect(github.statusCode).toBe(400);
      const other = await post({ ...validSiteBody, source: "gitlab" });
      expect(other.statusCode).toBe(400);
    });

    it("reports a Git API failure as GIT_API_ERROR", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
      const res = await post(giteaSiteBody);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe("GIT_API_ERROR");
    });
  });
});
