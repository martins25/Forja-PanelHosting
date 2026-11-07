// Abuse tests: IDOR between clients. Client A (alice, account 1) plays the
// attacker against every kind of resource of client B (bob, account 2).
// A passing test means the attack was REJECTED. If one fails there is an
// authorization hole to fix in the route (see docs/SEGURIDAD.md, 2.5).
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import * as schema from "../db/schema.js";
import { createAbuseEnv, MARKERS, type AbuseEnv } from "./abuse-env.js";

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

interface Attack {
  name: string;
  method: Method;
  url: string;
  payload?: unknown;
}

const HEX64 = "a".repeat(64);

// What client A may try against client B's resources (site 2, account 2, etc.).
const attacks: Attack[] = [
  // --- sites ---
  { name: "read site of another client", method: "GET", url: "/api/sites/2" },
  { name: "deploy site of another client", method: "POST", url: "/api/sites/2/deploy" },
  { name: "switch another client's site to maintenance", method: "PATCH", url: "/api/sites/2/mode", payload: { mode: "disabled" } },
  { name: "create a site inside another client's account", method: "POST", url: "/api/sites", payload: { accountId: 2, primaryDomain: "evil.example.com", runtime: "node", source: "github", repo: "https://github.com/alice/evil", branch: "main" } },
  // --- env vars ---
  { name: "list env vars of another client's site", method: "GET", url: "/api/sites/2/env" },
  { name: "add env var to another client's site", method: "POST", url: "/api/sites/2/env", payload: { key: "EVIL", value: "1" } },
  { name: "overwrite env var of another client", method: "PATCH", url: "/api/sites/2/env/2", payload: { value: "hacked" } },
  { name: "delete env var of another client", method: "DELETE", url: "/api/sites/2/env/2" },
  { name: "overwrite B's env var through A's own site id", method: "PATCH", url: "/api/sites/1/env/2", payload: { value: "hacked" } },
  { name: "delete B's env var through A's own site id", method: "DELETE", url: "/api/sites/1/env/2" },
  // --- logs / deployments ---
  { name: "read runtime logs of another client's site", method: "GET", url: "/api/sites/2/logs" },
  { name: "read access logs of another client's site", method: "GET", url: "/api/sites/2/logs?source=access" },
  { name: "read build log of another client's deployment", method: "GET", url: "/api/sites/2/deployments/2/log" },
  { name: "read B's build log through A's own site id", method: "GET", url: "/api/sites/1/deployments/2/log" },
  // --- databases ---
  { name: "list databases of another client", method: "GET", url: "/api/accounts/2/databases" },
  { name: "create database in another client's account", method: "POST", url: "/api/accounts/2/databases", payload: { engine: "postgres", name: "evildb", db_user: "evil" } },
  { name: "drop database of another client", method: "DELETE", url: "/api/accounts/2/databases/2" },
  { name: "dump database of another client", method: "POST", url: "/api/accounts/2/databases/2/dump" },
  { name: "reset password of another client's database", method: "PATCH", url: "/api/accounts/2/databases/2/password" },
  { name: "start web tool on another client's database", method: "POST", url: "/api/accounts/2/databases/2/tool/start", payload: { tool: "adminer" } },
  { name: "stop web tool on another client's database", method: "POST", url: "/api/accounts/2/databases/2/tool/stop", payload: { tool: "adminer" } },
  { name: "drop B's database through A's own account id", method: "DELETE", url: "/api/accounts/1/databases/2" },
  { name: "dump B's database through A's own account id", method: "POST", url: "/api/accounts/1/databases/2/dump" },
  { name: "reset B's db password through A's own account id", method: "PATCH", url: "/api/accounts/1/databases/2/password" },
  { name: "start tool on B's database through A's own account id", method: "POST", url: "/api/accounts/1/databases/2/tool/start", payload: { tool: "adminer" } },
  // --- files ---
  { name: "list files of another client", method: "GET", url: "/api/accounts/2/files?path=." },
  { name: "read file of another client", method: "GET", url: "/api/accounts/2/files/content?path=.env" },
  { name: "write file in another client's account", method: "PUT", url: "/api/accounts/2/files/content", payload: { path: "index.php", content: "<?php system($_GET[0]);" } },
  { name: "delete file of another client", method: "DELETE", url: "/api/accounts/2/files?path=index.js&recursive=true" },
  { name: "mkdir in another client's account", method: "POST", url: "/api/accounts/2/files/mkdir", payload: { path: "evil" } },
  { name: "upload into another client's account", method: "POST", url: "/api/accounts/2/files/upload", payload: { path: "x.php", content_base64: "eA==" } },
  // --- backups ---
  { name: "list backups of another client", method: "GET", url: "/api/accounts/2/backups" },
  { name: "run backup of another client's account", method: "POST", url: "/api/accounts/2/backups", payload: { scope: "all" } },
  { name: "export another client's account", method: "POST", url: "/api/accounts/2/backups/export", payload: {} },
  { name: "download another client's export", method: "GET", url: `/api/accounts/2/backups/export/${HEX64}` },
  { name: "restore another client's backup", method: "POST", url: "/api/accounts/2/backups/2/restore", payload: { target: "all", confirm: true } },
  { name: "restore B's backup through A's own account id", method: "POST", url: "/api/accounts/1/backups/2/restore", payload: { target: "all", confirm: true } },
  // --- stats / certificates ---
  { name: "read stats of another client's site", method: "GET", url: "/api/sites/2/stats" },
  { name: "refresh stats of another client's site", method: "POST", url: "/api/sites/2/stats/refresh" },
  { name: "read certificate of another client's site", method: "GET", url: "/api/sites/2/certificate" },
  { name: "request certificate for another client's site", method: "POST", url: "/api/sites/2/certificate" },
  { name: "renew certificate of another client's site", method: "POST", url: "/api/sites/2/certificate/renew" },
  // --- removal requests ---
  { name: "request removal of another client's site", method: "POST", url: "/api/sites/2/removal-request", payload: { reason: "pwn" } },
  { name: "approve a removal request (admin only)", method: "PATCH", url: "/api/removal-requests/2", payload: { status: "done" } },
  { name: "approve own removal request (admin only)", method: "PATCH", url: "/api/removal-requests/1", payload: { status: "done" } },
  // --- alerts ---
  { name: "edit another client's alert channel", method: "PATCH", url: "/api/alerts/channels/2", payload: { address: "attacker@evil.example" } },
  { name: "disable another client's alert channel", method: "PATCH", url: "/api/alerts/channels/2", payload: { enabled: false } },
  { name: "delete another client's alert channel", method: "DELETE", url: "/api/alerts/channels/2" },
  { name: "delete another client's alert rule", method: "DELETE", url: "/api/alerts/rules/2" },
  { name: "bind own rule to another client's channel", method: "POST", url: "/api/alerts/rules", payload: { event: "site_down", channelId: 2 } },
  // --- accounts ---
  { name: "read another client's account", method: "GET", url: "/api/accounts/2" },
  { name: "read another client's usage", method: "GET", url: "/api/accounts/2/usage" },
  { name: "suspend another client's account", method: "POST", url: "/api/accounts/2/suspend" },
  { name: "suspend own account (admin only)", method: "POST", url: "/api/accounts/1/suspend" },
  { name: "resume another client's account", method: "POST", url: "/api/accounts/2/resume" },
  { name: "create an account (admin only)", method: "POST", url: "/api/accounts", payload: { slug: "evilacct", planId: 1 } },
  // --- git / cloudflare ---
  { name: "delete another client's git integration", method: "DELETE", url: "/api/git-integrations/2" },
  { name: "read another client's cloudflare connection", method: "GET", url: "/api/cf-connections/1" },
  { name: "link own account to another client's cloudflare connection", method: "POST", url: "/api/cf-connections/1/accounts", payload: { accountId: 1 } },
  { name: "unlink another client's account from its cloudflare connection", method: "DELETE", url: "/api/cf-connections/1/accounts/2" },
  { name: "apply another client's tunnel", method: "POST", url: "/api/cf-connections/1/apply" },
  { name: "sync routes of another client's tunnel", method: "POST", url: "/api/cf-connections/1/sync-routes" },
  { name: "delete another client's cloudflare connection", method: "DELETE", url: "/api/cf-connections/1" },
  // --- users, invitations, plans (admin only) ---
  { name: "list users", method: "GET", url: "/api/users" },
  { name: "promote self to admin", method: "PATCH", url: "/api/users/2", payload: { role: "admin" } },
  { name: "disable another client's user", method: "PATCH", url: "/api/users/3", payload: { disabled: true } },
  { name: "delete another client's user", method: "DELETE", url: "/api/users/3" },
  { name: "assign self to another client's account", method: "POST", url: "/api/users/2/accounts", payload: { accountId: 2 } },
  { name: "unassign another client from their account", method: "DELETE", url: "/api/users/3/accounts/2" },
  { name: "list invitations", method: "GET", url: "/api/invitations" },
  { name: "invite an admin", method: "POST", url: "/api/invitations", payload: { email: "evil@evil.example", role: "admin", accountIds: [] } },
  { name: "revoke invitation", method: "DELETE", url: "/api/invitations/1" },
  { name: "create a plan", method: "POST", url: "/api/plans", payload: { name: "Evil", cpuMillis: 16000, memoryMb: 65536, diskMb: 1000000, maxSites: 999, maxDatabases: 999 } },
  { name: "raise own plan limits", method: "PUT", url: "/api/plans/1", payload: { name: "Basic", cpuMillis: 16000, memoryMb: 65536, diskMb: 1000000, maxSites: 999, maxDatabases: 999 } },
  { name: "delete a plan", method: "DELETE", url: "/api/plans/1" },
];

function leaks(body: string): string[] {
  return Object.values(MARKERS).filter((m) => body.includes(m));
}

/** Everything client B owns plus the shared tables an attack could tamper with. */
function snapshot(env: AbuseEnv): string {
  const t = (name: string, rows: unknown[]) => [name, rows];
  return JSON.stringify([
    t("users", env.db.select().from(schema.users).all()),
    t("userAccounts", env.db.select().from(schema.userAccounts).all()),
    t("plans", env.db.select().from(schema.plans).all()),
    t("accounts", env.db.select().from(schema.accounts).all()),
    t("sites", env.db.select().from(schema.sites).all()),
    t("envVars", env.db.select().from(schema.envVars).all()),
    t("databases", env.db.select().from(schema.databases).all()),
    t("backups", env.db.select().from(schema.backups).all()),
    t("certificates", env.db.select().from(schema.certificates).all()),
    t("removalRequests", env.db.select().from(schema.removalRequests).all()),
    t("alertChannels", env.db.select().from(schema.alertChannels).all()),
    t("alertRules", env.db.select().from(schema.alertRules).all()),
    t("gitIntegrations", env.db.select().from(schema.gitIntegrations).all()),
    t("cfConnections", env.db.select().from(schema.cfConnections).all()),
    t("invitations", env.db.select().from(schema.invitations).all()),
  ]);
}

describe("abuse: IDOR between clients", () => {
  let env: AbuseEnv;
  let before: string;

  beforeAll(async () => {
    env = await createAbuseEnv();
    before = snapshot(env);
  });

  afterAll(async () => {
    await env.close();
  });

  beforeEach(() => {
    env.callAction.mockClear();
  });

  // Controls: if these fail the fixture is broken and every "rejected" below
  // would be meaningless.
  describe("controls (legitimate access works)", () => {
    it("owner client B can read their own site", async () => {
      const res = await env.as("clientB", "GET", "/api/sites/2");
      expect(res.statusCode).toBe(200);
    });

    it("owner client A can read their own site", async () => {
      const res = await env.as("clientA", "GET", "/api/sites/1");
      expect(res.statusCode).toBe(200);
    });

    it("admin can read both clients' sites", async () => {
      expect((await env.as("admin", "GET", "/api/sites/1")).statusCode).toBe(200);
      expect((await env.as("admin", "GET", "/api/sites/2")).statusCode).toBe(200);
    });

    it("client A can list env vars of their own site", async () => {
      expect((await env.as("clientA", "GET", "/api/sites/1/env")).statusCode).toBe(200);
    });
  });

  describe("client A attacks client B's resources", () => {
    it.each(attacks)("$name ($method $url) is rejected", async (a) => {
      const res = await env.as("clientA", a.method, a.url, a.payload);

      expect([403, 404], `${a.method} ${a.url} answered ${res.statusCode}: ${res.body}`).toContain(
        res.statusCode,
      );
      expect(leaks(res.body)).toEqual([]);
      expect(env.callAction, "the agent must not run anything for a rejected request").not.toHaveBeenCalled();
    });
  });

  describe("unauthenticated attacker", () => {
    it.each(attacks)("$name ($method $url) needs a session", async (a) => {
      const res = await env.app.inject({ method: a.method, url: a.url, payload: a.payload as never });
      expect(res.statusCode).toBe(401);
      expect(leaks(res.body)).toEqual([]);
      expect(env.callAction).not.toHaveBeenCalled();
    });
  });

  describe("consecutive and disguised numeric IDs", () => {
    const idRoutes = [
      (id: string) => `/api/sites/${id}`,
      (id: string) => `/api/sites/${id}/env`,
      (id: string) => `/api/sites/${id}/logs`,
      (id: string) => `/api/sites/${id}/stats`,
      (id: string) => `/api/sites/${id}/certificate`,
      (id: string) => `/api/sites/${id}/deployments/${id}/log`,
      (id: string) => `/api/accounts/${id}`,
      (id: string) => `/api/accounts/${id}/usage`,
      (id: string) => `/api/accounts/${id}/databases`,
      (id: string) => `/api/accounts/${id}/backups`,
      (id: string) => `/api/accounts/${id}/files?path=.`,
    ];

    it("walking ids 0..30 only ever reveals the attacker's own resources", async () => {
      const own = new Set(["1"]);
      for (const route of idRoutes) {
        for (let n = 0; n <= 30; n++) {
          const id = String(n);
          const res = await env.as("clientA", "GET", route(id));
          const url = route(id);
          if (own.has(id) && res.statusCode === 200) continue;
          expect([400, 403, 404], `GET ${url} answered ${res.statusCode}`).toContain(res.statusCode);
          expect(leaks(res.body), `GET ${url} leaked B data`).toEqual([]);
        }
      }
      // Requests for the attacker's own site (id 1) may legitimately reach the
      // agent, but never on behalf of client B's account.
      for (const [action, params] of env.callAction.mock.calls) {
        const p = params as { account_slug?: string; domain?: string };
        expect(p.account_slug, `agent action ${String(action)}`).not.toBe("acct2");
        expect(p.domain, `agent action ${String(action)}`).not.toBe(MARKERS.domain);
      }
    });

    it.each([
      "2.0", "02", "002", "0x2", "0b10", "2e0", "+2", "%202", "%32", "2%00", "2abc", "-1", "0",
      "99999999999999999999", "NaN", "Infinity", "null", "undefined", "true", "[2]", "2,1", "1,2",
      "%5B2%5D", "1%2F..%2F2",
    ])("encoded or malformed id %j never exposes client B", async (id) => {
      for (const route of idRoutes) {
        const url = route(id);
        const res = await env.as("clientA", "GET", url);
        if (res.statusCode === 200) {
          // Only legal if the id really collapsed to the attacker's own resource.
          expect(leaks(res.body), `GET ${url} leaked B data`).toEqual([]);
          continue;
        }
        expect(res.statusCode, `GET ${url}`).toBeLessThan(500);
        expect(leaks(res.body), `GET ${url} leaked B data`).toEqual([]);
      }
    });
  });

  describe("listings without a filter only contain the caller's data", () => {
    const listings = [
      "/api/sites",
      "/api/accounts",
      "/api/me/accounts",
      "/api/audit",
      "/api/removal-requests",
      "/api/alerts/channels",
      "/api/alerts/rules",
      "/api/alerts/log",
      "/api/git-integrations",
      "/api/cf-connections",
      "/api/plans",
      "/api/system",
    ];

    it.each(listings)("GET %s does not include client B's data", async (url) => {
      const res = await env.as("clientA", "GET", url);
      expect(res.statusCode, `${url}: ${res.body}`).toBeLessThan(500);
      expect(leaks(res.body)).toEqual([]);
      if (res.statusCode === 200 && /^\/api\/(sites|accounts)$/.test(url)) {
        const rows = res.json() as { id: number }[];
        expect(rows.map((r) => r.id)).toEqual([1]);
      }
    });

    it.each([
      "/api/sites?accountId=2",
      "/api/sites?account_id=2",
      "/api/sites?accountId=1&accountId=2",
      "/api/sites?accountId[]=2",
      "/api/sites?userId=3",
      "/api/sites?all=true",
      "/api/sites?owner=bob",
      "/api/accounts?userId=3",
      "/api/accounts?all=1",
      "/api/audit?actorUserId=3",
      "/api/audit?actorUserId=3&actorUserId=2",
      "/api/audit?targetType=site&action=site.create&limit=100&page=1",
      "/api/audit?limit=-1",
      "/api/removal-requests?siteId=2",
      "/api/removal-requests?status=open&all=true",
      "/api/alerts/log?channelId=2",
      "/api/alerts/rules?userId=3",
      "/api/alerts/channels?userId=3",
      "/api/git-integrations?ownerUserId=3",
      "/api/cf-connections?ownerUserId=3",
    ])("filter smuggling %s does not widen the listing", async (url) => {
      const res = await env.as("clientA", "GET", url);
      expect(res.statusCode, `${url}: ${res.body}`).toBeLessThan(500);
      expect(leaks(res.body)).toEqual([]);
      if (res.statusCode === 200 && /^\/api\/sites\?/.test(url)) {
        const rows = res.json() as { id: number }[];
        expect(rows.map((r) => r.id)).toEqual([1]);
      }
    });

    it("a client's audit trail never contains another actor's entries", async () => {
      env.db.insert(schema.auditLog).values({
        actorUserId: 3, actorKind: "user", action: "site.deploy", targetType: "site",
        targetId: "2", result: "ok", at: new Date().toISOString(),
      }).run();
      const res = await env.as("clientA", "GET", "/api/audit?actorUserId=3&limit=100");
      expect(res.statusCode).toBe(200);
      const rows = (res.json() as { data: { actorUserId: number }[] }).data;
      expect(rows.every((r) => r.actorUserId === 2)).toBe(true);
    });
  });

  describe("secrets of the attacker's OWN resources stay masked", () => {
    it("env var values are masked in listings", async () => {
      const res = await env.as("clientA", "GET", "/api/sites/1/env");
      expect(res.body).not.toContain("a-value");
    });

    it("database listing never returns passwords", async () => {
      const res = await env.as("clientA", "GET", "/api/accounts/1/databases");
      expect(res.body).not.toContain("a-db-pass");
      expect(res.body).not.toMatch(/passwordEnc|password_enc|rootPassword/i);
    });

    it("site detail never returns the webhook secret", async () => {
      const res = await env.as("clientA", "GET", "/api/sites/1");
      expect(res.body).not.toContain("secret-of-site-a");
      expect(res.body).not.toMatch(/webhookSecretEnc/);
    });
  });

  it("no attack changed any data (state is identical to the start)", () => {
    expect(snapshot(env)).toBe(before);
  });
});
