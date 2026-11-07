// Abuse tests: path traversal against every endpoint that takes a path or a
// name that ends up on disk. A passing test means the attack was REJECTED (or,
// for ambiguous inputs, that whatever reached the agent was confined to the
// account home). If one fails there is a vulnerability to fix.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import path from "node:path";

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { createAbuseEnv, type AbuseEnv } from "./abuse-env.js";

/** True when `p` still points inside the account home once resolved. */
function confined(p: unknown): boolean {
  if (typeof p !== "string") return false;
  if (p.includes("\0")) return false;
  if (p.startsWith("/")) return false;
  const n = path.posix.normalize(p);
  return n !== ".." && !n.startsWith("../");
}

/** Paths that can only be an attack: the API itself must answer 400. */
const HOSTILE_PATHS: { name: string; raw: string }[] = [
  { name: "classic ../../etc/passwd", raw: "../../etc/passwd" },
  { name: "deep traversal to /etc/shadow", raw: "../../../../../../../../etc/shadow" },
  { name: "absolute /etc/shadow", raw: "/etc/shadow" },
  { name: "absolute /root/.ssh/id_rsa", raw: "/root/.ssh/id_rsa" },
  { name: "absolute /proc/self/environ", raw: "/proc/self/environ" },
  { name: "absolute path of another account", raw: "/srv/forja/accounts/acct2/sites/b-private.example.com/.env" },
  { name: "url-encoded dots and slash (%2e%2e%2f)", raw: "%2e%2e%2f%2e%2e%2fetc%2fpasswd" },
  { name: "url-encoded dots, literal slash", raw: "%2e%2e/%2e%2e/etc/passwd" },
  { name: "uppercase url-encoding (%2E%2E%2F)", raw: "%2E%2E%2F%2E%2E%2Fetc%2Fpasswd" },
  { name: "null byte truncation (%00)", raw: "index.js%00.png" },
  { name: "null byte then traversal", raw: "ok.txt%00/../../../etc/passwd" },
  { name: "leading null byte", raw: "%00../../etc/passwd" },
  { name: "dot-dot-slash inside a nested path", raw: "a/b/../../../../etc/passwd" },
  { name: "current dir then traversal", raw: "./../../etc/passwd" },
  { name: "bare ..", raw: ".." },
  { name: "bare ../", raw: "../" },
  { name: "traversal with a sibling account", raw: "../acct2/sites/b-private.example.com/.env" },
  { name: "control characters (newline)", raw: "index.js%0a../../etc/passwd" },
  { name: "control characters (CR)", raw: "index.js%0d" },
  { name: "backslash traversal (..\\..\\)", raw: "..%5c..%5cetc%5cpasswd" },
  { name: "mixed slash and backslash traversal", raw: "..%2f..%5c..%2fetc%2fpasswd" },
];

/** Inputs that look odd but stay inside the home once decoded exactly once. */
const AMBIGUOUS_PATHS: { name: string; raw: string }[] = [
  { name: "double-encoded ..%252f (decodes once to a literal name)", raw: "..%252f..%252fetc%252fpasswd" },
  { name: "doubled dots and slashes (....//)", raw: "....//....//etc/passwd" },
  { name: "dots with trailing spaces", raw: "..%20/..%20/etc" },
  { name: "unicode fullwidth dots", raw: "%EF%BC%8E%EF%BC%8E/%EF%BC%8E%EF%BC%8E/etc/passwd" },
  { name: "overlong utf-8 slash", raw: "..%c0%af..%c0%afetc" },
  { name: "tilde expansion attempt", raw: "~root/.ssh/id_rsa" },
  { name: "shell variable in path", raw: "$HOME/../../etc" },
  { name: "file:// scheme", raw: "file:///etc/passwd" },
  { name: "dash-leading file name", raw: "-rf" },
];

interface FileEndpoint {
  name: string;
  action: string;
  send: (env: AbuseEnv, rawPath: string) => ReturnType<AbuseEnv["as"]>;
}

// `raw` is sent verbatim in the query string (already percent-encoded where
// the attack needs it) and decoded once for JSON bodies.
const decodeOnce = (raw: string) => decodeURIComponent(raw.replace(/%(?![0-9a-fA-F]{2})/g, "%25"));
const safeDecode = (raw: string) => {
  try {
    return decodeOnce(raw);
  } catch {
    return raw;
  }
};

const FILE_ENDPOINTS: FileEndpoint[] = [
  {
    name: "GET files (list)",
    action: "files.list",
    send: (env, raw) => env.as("clientA", "GET", `/api/accounts/1/files?path=${raw}`),
  },
  {
    name: "GET files/content (read)",
    action: "files.read",
    send: (env, raw) => env.as("clientA", "GET", `/api/accounts/1/files/content?path=${raw}`),
  },
  {
    name: "DELETE files",
    action: "files.delete",
    send: (env, raw) => env.as("clientA", "DELETE", `/api/accounts/1/files?path=${raw}&recursive=true`),
  },
  {
    name: "PUT files/content (write)",
    action: "files.write",
    send: (env, raw) =>
      env.as("clientA", "PUT", "/api/accounts/1/files/content", { path: safeDecode(raw), content: "x" }),
  },
  {
    name: "POST files/mkdir",
    action: "files.mkdir",
    send: (env, raw) => env.as("clientA", "POST", "/api/accounts/1/files/mkdir", { path: safeDecode(raw) }),
  },
  {
    name: "POST files/upload (path)",
    action: "files.upload",
    send: (env, raw) =>
      env.as("clientA", "POST", "/api/accounts/1/files/upload", { path: safeDecode(raw), content_base64: "eA==" }),
  },
];

describe("abuse: path traversal", () => {
  let env: AbuseEnv;

  beforeAll(async () => {
    env = await createAbuseEnv();
  });
  afterAll(async () => {
    await env.close();
  });
  beforeEach(() => {
    env.callAction.mockClear();
  });

  /** Every path value that reached the agent, for the given action. */
  const reached = (action: string) =>
    env.callAction.mock.calls
      .filter(([name]) => name === action)
      .map(([, params]) => (params as { path?: unknown }).path);

  describe("file manager endpoints", () => {
    for (const ep of FILE_ENDPOINTS) {
      describe(ep.name, () => {
        it(`accepts a legitimate relative path (control)`, async () => {
          const res = await ep.send(env, "sites/index.js");
          expect(res.statusCode).toBeLessThan(300);
          expect(reached(ep.action)).toEqual(["sites/index.js"]);
        });

        it.each(HOSTILE_PATHS)("rejects $name", async ({ raw }) => {
          const res = await ep.send(env, raw);
          expect(res.statusCode, `${ep.name} ${raw}: ${res.body}`).toBe(400);
          expect(env.callAction, "the agent must not be called with a hostile path").not.toHaveBeenCalled();
        });

        it.each(AMBIGUOUS_PATHS)("never lets $name escape the account home", async ({ raw }) => {
          const res = await ep.send(env, raw);
          expect(res.statusCode, res.body).toBeLessThan(500);
          for (const p of reached(ep.action)) {
            expect(confined(p), `escaping path reached the agent: ${JSON.stringify(p)}`).toBe(true);
          }
        });
      });
    }

    it("rejects an absurdly long path", async () => {
      const long = "a/".repeat(5000);
      for (const ep of FILE_ENDPOINTS) {
        const res = await ep.send(env, long);
        expect([400, 414], `${ep.name}`).toContain(res.statusCode);
      }
      expect(env.callAction).not.toHaveBeenCalled();
    });

    it("rejects repeated query parameters (?path=ok&path=../../etc)", async () => {
      for (const url of [
        "/api/accounts/1/files?path=ok&path=../../etc",
        "/api/accounts/1/files/content?path=ok&path=../../etc/passwd",
        "/api/accounts/1/files?path=../../etc&path=ok",
      ]) {
        const res = await env.as("clientA", "GET", url);
        expect(res.statusCode, url).toBe(400);
      }
      expect(env.callAction).not.toHaveBeenCalled();
    });

    it("rejects non-string path values in JSON bodies", async () => {
      const weird: unknown[] = [["../../etc/passwd"], { $ne: "" }, 123, true, null, { toString: "../../etc" }];
      for (const value of weird) {
        for (const [method, url, extra] of [
          ["PUT", "/api/accounts/1/files/content", { content: "x" }],
          ["POST", "/api/accounts/1/files/mkdir", {}],
          ["POST", "/api/accounts/1/files/upload", { content_base64: "eA==" }],
        ] as const) {
          const res = await env.as("clientA", method, url, { path: value, ...extra });
          expect(res.statusCode, `${method} ${url} path=${JSON.stringify(value)}`).toBe(400);
        }
      }
      expect(env.callAction).not.toHaveBeenCalled();
    });

    it("rejects a non-string content_base64 / content", async () => {
      for (const content of [["a"], { a: 1 }, 5]) {
        const res = await env.as("clientA", "PUT", "/api/accounts/1/files/content", { path: "ok.txt", content });
        expect(res.statusCode).toBe(400);
      }
      for (const b64 of [["eA=="], { a: 1 }, 5]) {
        const res = await env.as("clientA", "POST", "/api/accounts/1/files/upload", { path: "ok.txt", content_base64: b64 });
        expect(res.statusCode).toBe(400);
      }
      expect(env.callAction).not.toHaveBeenCalled();
    });
  });

  describe("upload with a malicious file name", () => {
    const names = [
      "../../etc/crontab",
      "../../../etc/cron.d/pwn",
      "uploads/../../../etc/crontab",
      "/etc/crontab",
      "..%2f..%2fetc%2fcrontab",
      "x.php%00.png",
      "uploads/..\\..\\etc\\crontab",
      "../../root/.ssh/authorized_keys",
    ];
    it.each(names)("upload as %j is rejected or confined", async (raw) => {
      const name = safeDecode(raw);
      const res = await env.as("clientA", "POST", "/api/accounts/1/files/upload", {
        path: name,
        content_base64: Buffer.from("* * * * * root id").toString("base64"),
      });
      expect(res.statusCode).toBeLessThan(500);
      for (const p of reached("files.upload")) {
        expect(confined(p), `escaping upload name reached the agent: ${JSON.stringify(p)}`).toBe(true);
      }
      // Names that are unambiguous traversal must be refused outright.
      if (name.includes("..") && /(^|[\\/])\.\.([\\/]|$)/.test(name) || name.startsWith("/") || name.includes("\0")) {
        expect(res.statusCode).toBe(400);
      }
    });
  });

  describe("site names and domains", () => {
    const newSite = (primaryDomain: unknown, extra: Record<string, unknown> = {}) => ({
      accountId: 1,
      primaryDomain,
      runtime: "node",
      source: "github",
      repo: "https://github.com/alice/a-repo",
      branch: "main",
      ...extra,
    });

    const hostileDomains = [
      "../../etc/passwd",
      "..",
      "a.com/../../etc/passwd",
      "a.com/..",
      "a.com/../b.com",
      "/etc/passwd",
      "a/b.com",
      "a.com/",
      "a.com\\..\\..\\x",
      "a.com\0.evil.com",
      "a.com%00.evil.com",
      "..%2f..%2fetc.com",
      "%2e%2e%2f.com",
      "a.com:8080/..",
      "a.com?x=../../",
      "a.com#../..",
      " a.com",
      "a.com ",
      "a..com",
      ".a.com",
      "a.com.",
      "localhost",
    ];

    it.each(hostileDomains)("POST /api/sites rejects primaryDomain %j", async (domain) => {
      const before = env.db.select().from(schema.sites).all().length;
      const res = await env.as("clientA", "POST", "/api/sites", newSite(domain));
      expect(res.statusCode, res.body).toBe(400);
      expect(env.callAction, "agent must not see the hostile domain").not.toHaveBeenCalled();
      expect(env.db.select().from(schema.sites).all().length).toBe(before);
    });

    it.each(["../../etc", "public/../../etc", "/etc", "..", "public\0", "a/../..", "..\\..\\x"])(
      "POST /api/sites rejects publicDir %j",
      async (publicDir) => {
        const res = await env.as("clientA", "POST", "/api/sites", newSite("ok-public.example.com", { runtime: "static", publicDir }));
        expect(res.statusCode, res.body).toBe(400);
        expect(env.callAction).not.toHaveBeenCalled();
      },
    );

    it.each(["../../etc", "feature/../../etc", "..", "a/../b", "--upload-pack=x", "-x"])(
      "POST /api/sites rejects branch %j",
      async (branch) => {
        const res = await env.as("clientA", "POST", "/api/sites", newSite("ok-branch.example.com", { branch }));
        expect(res.statusCode, res.body).toBe(400);
        expect(env.callAction).not.toHaveBeenCalled();
      },
    );

    it.each([
      "https://github.com/../../etc/passwd",
      "https://github.com/alice/../../x",
      "https://github.com/alice/..",
      "file:///etc/passwd",
      "https://github.com/%2e%2e/%2e%2e/x",
    ])("POST /api/sites rejects repo %j", async (repo) => {
      const res = await env.as("clientA", "POST", "/api/sites", newSite("ok-repo.example.com", { repo }));
      expect(res.statusCode, res.body).toBe(400);
      expect(env.callAction).not.toHaveBeenCalled();
    });

    it("never persisted any site with a hostile domain", () => {
      const rows = env.db.select().from(schema.sites).all();
      expect(rows.map((r) => r.primaryDomain).sort()).toEqual(["a.example.com", "b-private.example.com"]);
    });
  });

  describe("account slugs", () => {
    const hostileSlugs = [
      "../x",
      "../../etc",
      "..",
      "a/b",
      "acct/../x",
      "/abs",
      "ACCT",
      ".hidden",
      "a\0b",
      "acct%00",
      "acct%2f..%2f",
      "ab",
      "-rf",
      "acct;id",
      "acct\n",
    ];

    it.each(hostileSlugs)("POST /api/accounts rejects slug %j", async (slug) => {
      const before = env.db.select().from(schema.accounts).all().length;
      const res = await env.as("admin", "POST", "/api/accounts", { slug, planId: 1 });
      expect(res.statusCode, res.body).toBe(400);
      expect(env.callAction, "agent must not create an account for a hostile slug").not.toHaveBeenCalled();
      expect(env.db.select().from(schema.accounts).all().length).toBe(before);
    });
  });

  describe("log paths", () => {
    const poisoned = [
      "../../../../etc/passwd",
      "../../app/.env",
      "logs/../../../x",
      "build.log\0../../x",
      "/srv/forja/accounts/acct1/sites/a.example.com/logs/../../../../../etc/shadow",
    ];

    it.each(poisoned)("never forwards a poisoned deployment log path %j to the agent", async (logPath) => {
      env.db.update(schema.deployments).set({ logPath }).where(eq(schema.deployments.id, 1)).run();
      try {
        const res = await env.as("clientA", "GET", "/api/sites/1/deployments/1/log");
        expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
        expect(res.statusCode).toBeLessThan(500);
        const logCalls = env.callAction.mock.calls.filter(([a]) => a === "logs.tail");
        for (const [, params] of logCalls) {
          const lp = (params as { log_path?: string }).log_path ?? "";
          expect(lp.split(/[\\/]/)).not.toContain("..");
          expect(lp).not.toContain("\0");
        }
      } finally {
        env.db
          .update(schema.deployments)
          .set({ logPath: "/srv/forja/accounts/acct1/sites/a.example.com/logs/build-a.log" })
          .where(eq(schema.deployments.id, 1))
          .run();
      }
    });

    it("forwards a legitimate build log path (control)", async () => {
      const res = await env.as("clientA", "GET", "/api/sites/1/deployments/1/log");
      expect(res.statusCode).toBe(200);
      const call = env.callAction.mock.calls.find(([a]) => a === "logs.tail");
      expect(call).toBeTruthy();
    });

    it("the client cannot choose the log path or source through the query string", async () => {
      for (const url of [
        "/api/sites/1/logs?log_path=../../etc/passwd",
        "/api/sites/1/logs?path=../../etc/passwd",
        "/api/sites/1/logs?source=build&log_path=../../etc/passwd",
        "/api/sites/1/logs?source=../../etc/passwd",
        "/api/sites/1/logs?source=app&source=build",
        "/api/sites/1/deployments/1/log?log_path=../../etc/passwd",
        "/api/sites/1/deployments/1/log?path=/etc/shadow",
      ]) {
        env.callAction.mockClear();
        const res = await env.as("clientA", "GET", url);
        expect(res.statusCode, url).toBeLessThan(500);
        for (const [, params] of env.callAction.mock.calls) {
          const p = params as { log_path?: string; source?: string };
          expect(p.log_path ?? "", url).not.toContain("etc/passwd");
          expect(p.log_path ?? "", url).not.toContain("etc/shadow");
          expect(["app", "access", "build", undefined], url).toContain(p.source);
        }
      }
    });
  });

  describe("export download token", () => {
    it.each([
      "../../etc/passwd",
      "..%2f..%2fetc%2fpasswd",
      "a".repeat(63),
      "A".repeat(64),
      "g".repeat(64),
      `${"a".repeat(64)}/../../x`,
      `${"a".repeat(64)}%00`,
      "%2e%2e",
    ])("GET export/%s is rejected without touching the agent", async (token) => {
      const res = await env.as("clientA", "GET", `/api/accounts/1/backups/export/${token}`);
      expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
      expect(env.callAction).not.toHaveBeenCalled();
    });
  });

  describe("restore target", () => {
    it.each(["site:../../etc", "site:a.com/../x", "all; rm -rf /", "site:", "site:-x", "../all", "ALL"])(
      "restore target %j is rejected",
      async (target) => {
        const res = await env.as("admin", "POST", "/api/accounts/1/backups/1/restore", { target, confirm: true });
        expect(res.statusCode, res.body).toBe(400);
        expect(env.callAction).not.toHaveBeenCalled();
      },
    );
  });
});
