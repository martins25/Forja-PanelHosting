import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { randomBytes, createHmac } from "node:crypto";
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
  encryptSecret,
} from "../crypto/secrets.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

let sqlite: InstanceType<typeof Database>;

const webhookSecret = "a".repeat(64);
const secretKey = randomBytes(32);

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

describe("hook routes", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let mockCallAction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    setAppKeyForTest(randomBytes(32));
    setSecretKeyForTest(secretKey);
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

    const encSecret = encryptSecret(webhookSecret);
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
        webhookSecretEnc: encSecret,
        autodeploy: true,
      })
      .run();

    db.insert(schema.domains)
      .values({ siteId: 1, hostname: "example.com", kind: "primary" })
      .run();

    mockCallAction = vi.fn().mockImplementation(async (action: string) => {
      if (action === "site.deploy") {
        return {
          ok: true,
          result: {
            container_name: "fj-demo-example-com-green",
            active_port: 10001,
          },
        };
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

  function pushPayload(branch = "main") {
    return JSON.stringify({
      ref: `refs/heads/${branch}`,
      head_commit: {
        id: "abc1234567890abc1234567890abc1234567890a",
        message: "fix: something",
      },
    });
  }

  it("accepts valid push and triggers deploy", async () => {
    const app = await getApp();
    const body = pushPayload();

    const res = await app.inject({
      method: "POST",
      url: "/hooks/github/1",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body, webhookSecret),
        "x-github-delivery": "d-001",
        "x-github-event": "push",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("accepted");

    // Wait for async deploy to complete
    await new Promise((r) => setTimeout(r, 50));

    expect(mockCallAction).toHaveBeenCalledWith(
      "site.deploy",
      expect.objectContaining({
        account_slug: "demo",
        domain: "example.com",
      }),
    );

    const deliveries = db.select().from(schema.webhookDeliveries).all();
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].signatureOk).toBe(true);
    expect(deliveries[0].processed).toBe(true);
  });

  it("rejects invalid signature", async () => {
    const app = await getApp();
    const body = pushPayload();

    const res = await app.inject({
      method: "POST",
      url: "/hooks/github/1",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": "sha256=invalid",
        "x-github-delivery": "d-002",
        "x-github-event": "push",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("INVALID_SIGNATURE");

    // Deliveries with an invalid signature are not recorded.
    expect(db.select().from(schema.webhookDeliveries).all()).toHaveLength(0);
  });

  it("ignores duplicate delivery", async () => {
    const app = await getApp();
    const body = pushPayload();
    const sig = sign(body, webhookSecret);

    await app.inject({
      method: "POST",
      url: "/hooks/github/1",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-delivery": "d-003",
        "x-github-event": "push",
      },
      payload: body,
    });

    await new Promise((r) => setTimeout(r, 50));
    mockCallAction.mockClear();

    const res = await app.inject({
      method: "POST",
      url: "/hooks/github/1",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-delivery": "d-003",
        "x-github-event": "push",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("already_processed");
  });

  it("ignores wrong branch", async () => {
    const app = await getApp();
    const body = pushPayload("develop");
    const sig = sign(body, webhookSecret);

    const res = await app.inject({
      method: "POST",
      url: "/hooks/github/1",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-delivery": "d-004",
        "x-github-event": "push",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe("branch mismatch");
  });

  it("ignores non-push events", async () => {
    const app = await getApp();
    const body = pushPayload();
    const sig = sign(body, webhookSecret);

    const res = await app.inject({
      method: "POST",
      url: "/hooks/github/1",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-delivery": "d-005",
        "x-github-event": "issues",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe("not a push event");
  });

  it("ignores when autodeploy is disabled", async () => {
    db.update(schema.sites)
      .set({ autodeploy: false })
      .run();

    const app = await getApp();
    const body = pushPayload();
    const sig = sign(body, webhookSecret);

    const res = await app.inject({
      method: "POST",
      url: "/hooks/github/1",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-delivery": "d-006",
        "x-github-event": "push",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().reason).toBe("autodeploy disabled");
  });

  it("returns 404 for non-existent site", async () => {
    const app = await getApp();
    const body = pushPayload();

    const res = await app.inject({
      method: "POST",
      url: "/hooks/github/9999",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body, webhookSecret),
        "x-github-delivery": "d-007",
        "x-github-event": "push",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(404);
  });

  it("returns 400 when site has no webhook secret", async () => {
    db.update(schema.sites).set({ webhookSecretEnc: null }).run();

    const app = await getApp();
    const body = pushPayload();

    const res = await app.inject({
      method: "POST",
      url: "/hooks/github/1",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body, webhookSecret),
        "x-github-delivery": "d-008",
        "x-github-event": "push",
      },
      payload: body,
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("NO_WEBHOOK_SECRET");
  });

  it("returns 400 when missing headers", async () => {
    const app = await getApp();

    const res = await app.inject({
      method: "POST",
      url: "/hooks/github/1",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("MISSING_HEADERS");
  });

  it("writes audit on valid webhook", async () => {
    const app = await getApp();
    const body = pushPayload();

    await app.inject({
      method: "POST",
      url: "/hooks/github/1",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body, webhookSecret),
        "x-github-delivery": "d-009",
        "x-github-event": "push",
      },
      payload: body,
    });

    const logs = db.select().from(schema.auditLog).all();
    const entry = logs.find(
      (l) => l.action === "webhook.receive" && l.actorKind === "webhook",
    );
    expect(entry).toBeDefined();
  });
  describe("gitea", () => {
    const giteaSecret = "b".repeat(64);

    function giteaSign(body: string, secret: string): string {
      return createHmac("sha256", secret).update(body).digest("hex");
    }

    function giteaHeaders(body: string, delivery: string, extra: Record<string, string> = {}) {
      return {
        "content-type": "application/json",
        "x-gitea-signature": giteaSign(body, giteaSecret),
        "x-gitea-delivery": delivery,
        "x-gitea-event": "push",
        ...extra,
      };
    }

    beforeEach(() => {
      db.insert(schema.gitIntegrations)
        .values({
          provider: "gitea",
          baseUrl: "https://git.example.org",
          credentialsEnc: encryptSecret("token-1234567890"),
          webhookSecretEnc: encryptSecret("unused"),
        })
        .run();
      db.insert(schema.sites)
        .values({
          accountId: 1,
          primaryDomain: "gitea-site.com",
          runtime: "node",
          runtimeVersion: "22",
          source: "gitea",
          repo: "https://git.example.org/owner/repo.git",
          gitIntegrationId: 1,
          branch: "main",
          installCmd: "npm ci",
          startCmd: "npm start",
          internalPort: 10002,
          mode: "online",
          webhookSecretEnc: encryptSecret(giteaSecret),
          autodeploy: true,
        })
        .run();
      db.insert(schema.domains)
        .values({ siteId: 2, hostname: "gitea-site.com", kind: "primary" })
        .run();
    });

    it("accepts a valid push and deploys with the Gitea repo", async () => {
      const app = await getApp();
      const body = pushPayload();
      const res = await app.inject({
        method: "POST",
        url: "/hooks/gitea/2",
        headers: giteaHeaders(body, "g-001"),
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("accepted");
      await new Promise((r) => setTimeout(r, 50));

      expect(mockCallAction).toHaveBeenCalledWith(
        "site.deploy",
        expect.objectContaining({
          domain: "gitea-site.com",
          repo: "https://git.example.org/owner/repo.git",
        }),
      );
      const deliveries = db.select().from(schema.webhookDeliveries).all();
      expect(deliveries[0].provider).toBe("gitea");
      expect(deliveries[0].processed).toBe(true);
    });

    it("rejects an invalid signature", async () => {
      const app = await getApp();
      const body = pushPayload();
      const res = await app.inject({
        method: "POST",
        url: "/hooks/gitea/2",
        headers: giteaHeaders(body, "g-002", { "x-gitea-signature": "0".repeat(64) }),
        payload: body,
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe("INVALID_SIGNATURE");
      expect(db.select().from(schema.webhookDeliveries).all()).toHaveLength(0);
      expect(mockCallAction).not.toHaveBeenCalledWith("site.deploy", expect.anything());
    });

    it("rejects a signature of the wrong length and a signature made with another secret", async () => {
      const app = await getApp();
      const body = pushPayload();
      for (const [i, signature] of ["abc", giteaSign(body, webhookSecret)].entries()) {
        const res = await app.inject({
          method: "POST",
          url: "/hooks/gitea/2",
          headers: giteaHeaders(body, `g-bad-${i}`, { "x-gitea-signature": signature }),
          payload: body,
        });
        expect(res.statusCode).toBe(401);
      }
    });

    it("rejects the GitHub-style prefixed signature header on the Gitea route", async () => {
      const app = await getApp();
      const body = pushPayload();
      const res = await app.inject({
        method: "POST",
        url: "/hooks/gitea/2",
        headers: giteaHeaders(body, "g-003", {
          "x-gitea-signature": "sha256=" + giteaSign(body, giteaSecret),
        }),
        payload: body,
      });
      expect(res.statusCode).toBe(401);
    });

    it("requires the Gitea headers", async () => {
      const app = await getApp();
      const body = pushPayload();
      const res = await app.inject({
        method: "POST",
        url: "/hooks/gitea/2",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(body, giteaSecret),
          "x-github-delivery": "g-004",
          "x-github-event": "push",
        },
        payload: body,
      });
      expect(res.statusCode).toBe(400);
    });

    it("ignores pushes to another branch", async () => {
      const app = await getApp();
      const body = pushPayload("feature");
      const res = await app.inject({
        method: "POST",
        url: "/hooks/gitea/2",
        headers: giteaHeaders(body, "g-005"),
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().reason).toBe("branch mismatch");
      await new Promise((r) => setTimeout(r, 50));
      expect(mockCallAction).not.toHaveBeenCalledWith("site.deploy", expect.anything());
    });

    it("ignores non-push events", async () => {
      const app = await getApp();
      const body = pushPayload();
      const res = await app.inject({
        method: "POST",
        url: "/hooks/gitea/2",
        headers: giteaHeaders(body, "g-006", { "x-gitea-event": "issues" }),
        payload: body,
      });
      expect(res.json().status).toBe("ignored");
    });

    it("ignores duplicate deliveries", async () => {
      const app = await getApp();
      const body = pushPayload();
      const request = {
        method: "POST" as const,
        url: "/hooks/gitea/2",
        headers: giteaHeaders(body, "g-007"),
        payload: body,
      };
      await app.inject(request);
      const res = await app.inject(request);
      expect(res.json().status).toBe("already_processed");
    });

    it("does not accept a GitHub site on the Gitea route and vice versa", async () => {
      const app = await getApp();
      const body = pushPayload();
      const github = await app.inject({
        method: "POST",
        url: "/hooks/gitea/1",
        headers: {
          ...giteaHeaders(body, "g-008"),
          "x-gitea-signature": giteaSign(body, webhookSecret),
        },
        payload: body,
      });
      expect(github.statusCode).toBe(404);

      const gitea = await app.inject({
        method: "POST",
        url: "/hooks/github/2",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": sign(body, giteaSecret),
          "x-github-delivery": "g-009",
          "x-github-event": "push",
        },
        payload: body,
      });
      expect(gitea.statusCode).toBe(404);
    });

    it("looks up the latest commit on the Gitea instance when the payload has none", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ commit: { id: "d".repeat(40) } }),
      });
      const app = await getApp();
      const body = JSON.stringify({ ref: "refs/heads/main" });
      const res = await app.inject({
        method: "POST",
        url: "/hooks/gitea/2",
        headers: giteaHeaders(body, "g-010"),
        payload: body,
      });
      expect(res.statusCode).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      expect(mockFetch).toHaveBeenCalledWith(
        "https://git.example.org/api/v1/repos/owner/repo/branches/main",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "token token-1234567890" }),
        }),
      );
      expect(mockCallAction).toHaveBeenCalledWith(
        "site.deploy",
        expect.objectContaining({ commit: "d".repeat(40) }),
      );
    });
  });

  it("does not record deliveries with a bad signature, however many arrive", async () => {
    const app = await getApp();
    const body = pushPayload();
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/hooks/github/1",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": "sha256=" + "0".repeat(64),
          "x-github-delivery": `bad-${i}`,
          "x-github-event": "push",
        },
        payload: body,
      });
      expect(res.statusCode).toBe(401);
    }
    expect(db.select().from(schema.webhookDeliveries).all()).toHaveLength(0);
  });

  it("rate-limits webhooks to 60 requests per minute", async () => {
    const app = await buildApp({
      agentClient: { callAction: mockCallAction } as never,
    });
    const body = pushPayload();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) {
      const res = await app.inject({
        method: "POST",
        url: "/hooks/github/1",
        headers: {
          "content-type": "application/json",
          "x-hub-signature-256": "sha256=" + "0".repeat(64),
          "x-github-delivery": `rl-${i}`,
          "x-github-event": "push",
        },
        payload: body,
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true);
    expect(statuses[60]).toBe(429);
  });
});
