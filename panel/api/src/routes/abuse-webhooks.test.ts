// Abuse tests: forged webhooks. The attacker knows the public URL of a site's
// webhook but not its secret. A passing test means the forgery was REJECTED
// (nothing was deployed). If one fails there is a vulnerability to fix.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { createHmac, randomUUID } from "node:crypto";

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { buildApp } from "../app.js";
import { encryptSecret } from "../crypto/secrets.js";
import { createAbuseEnv, MARKERS, type AbuseEnv } from "./abuse-env.js";

const SITE_SECRET = "secret-of-site-a"; // site 1 (github)
const GITEA_SECRET = "secret-of-gitea-site";
const GITEA_SITE_ID = 3;

const ZERO_SHA = "0".repeat(40);
const GOOD_SHA = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2";

function hex(secret: string, body: string | Buffer): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const push = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    ref: "refs/heads/main",
    head_commit: { id: GOOD_SHA, message: "fix: something" },
    ...extra,
  });

describe("abuse: forged webhooks", () => {
  let env: AbuseEnv;

  beforeAll(async () => {
    env = await createAbuseEnv();
    // Site 3: a Gitea site with its own secret.
    env.db.insert(schema.sites).values({
      accountId: 1, primaryDomain: "gitea-site.example.com", runtime: "node", runtimeVersion: "22",
      source: "gitea", repo: "https://git.example.org/alice/g-repo.git", branch: "main", internalPort: 10004,
      webhookSecretEnc: encryptSecret(GITEA_SECRET), autodeploy: true,
    }).run();
  });
  afterAll(async () => {
    await env.close();
  });
  beforeEach(() => {
    env.callAction.mockClear();
  });

  interface Opts {
    siteId?: string | number;
    provider?: "github" | "gitea";
    body?: string | Buffer;
    secret?: string;
    signature?: string | null;
    delivery?: string | null;
    event?: string | null;
    contentType?: string | null;
    extraHeaders?: Record<string, string>;
  }

  /** Sends a webhook, signed with `secret` unless `signature` overrides it. */
  async function send(o: Opts = {}) {
    const provider = o.provider ?? "github";
    const body = o.body ?? push();
    const secret = o.secret ?? (provider === "github" ? SITE_SECRET : GITEA_SECRET);
    const prefix = provider === "github" ? "sha256=" : "";
    const headers: Record<string, string> = { ...o.extraHeaders };
    if (o.contentType !== null) headers["content-type"] = o.contentType ?? "application/json";
    const sigHeader = provider === "github" ? "x-hub-signature-256" : "x-gitea-signature";
    const delHeader = provider === "github" ? "x-github-delivery" : "x-gitea-delivery";
    const evHeader = provider === "github" ? "x-github-event" : "x-gitea-event";
    if (o.signature !== null) headers[sigHeader] = o.signature ?? prefix + hex(secret, body);
    if (o.delivery !== null) headers[delHeader] = o.delivery ?? randomUUID();
    if (o.event !== null) headers[evHeader] = o.event ?? "push";
    const siteId = o.siteId ?? (provider === "github" ? 1 : GITEA_SITE_ID);
    return env.app.inject({ method: "POST", url: `/hooks/${provider}/${siteId}`, headers, payload: body });
  }

  const deployCalls = () => env.callAction.mock.calls.filter(([a]) => a === "site.deploy");
  /** Lets the (asynchronous) deploy queue run; used before asserting "nothing was deployed". */
  const settle = () => new Promise((r) => setTimeout(r, 40));
  const deliveryRows = (id: string) =>
    env.db.select().from(schema.webhookDeliveries).where(eq(schema.webhookDeliveries.deliveryId, id)).all();

  async function expectNotDeployed(res: { statusCode: number }, ...allowed: number[]) {
    await settle();
    expect(allowed, `unexpected status ${res.statusCode}`).toContain(res.statusCode);
    expect(deployCalls(), "a forged webhook triggered a deploy").toHaveLength(0);
  }

  describe("control", () => {
    it("a correctly signed push deploys the stored repo and branch exactly once", async () => {
      const res = await send();
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().status).toBe("accepted");
      await vi.waitFor(() => expect(deployCalls()).toHaveLength(1));
      const params = deployCalls()[0][1] as Record<string, unknown>;
      expect(params.repo).toBe("https://github.com/alice/a-repo");
      expect(params.branch).toBe("main");
      expect(params.commit).toBe(GOOD_SHA);
      expect(params.account_slug).toBe("acct1");
    });

    it("a correctly signed Gitea push works with a bare hex signature", async () => {
      const res = await send({ provider: "gitea" });
      expect(res.statusCode, res.body).toBe(200);
      await vi.waitFor(() => expect(deployCalls()).toHaveLength(1));
    });
  });

  describe("missing or wrong signature", () => {
    it("rejects a webhook with no signature header", async () => {
      const res = await send({ signature: null });
      await expectNotDeployed(res, 400, 401);
    });

    it("rejects a webhook with an empty signature header", async () => {
      const res = await send({ signature: "" });
      await expectNotDeployed(res, 400, 401);
    });

    it("rejects a webhook with no delivery id", async () => {
      const res = await send({ delivery: null });
      await expectNotDeployed(res, 400, 401);
    });

    it("rejects a signature that is random hex of the right length", async () => {
      const res = await send({ signature: "sha256=" + "ab".repeat(32) });
      await expectNotDeployed(res, 401);
      expect(res.json().error.code).toBe("INVALID_SIGNATURE");
    });

    it("rejects a signature made with another site's secret", async () => {
      const res = await send({ secret: MARKERS.webhookSecret });
      await expectNotDeployed(res, 401);
    });

    it("rejects a signature made with the secret of an unrelated key", async () => {
      for (const secret of ["", "secret", "secret-of-site-a ", "SECRET-OF-SITE-A", GITEA_SECRET]) {
        const res = await send({ secret });
        await expectNotDeployed(res, 401);
      }
    });

    it("rejects a valid signature of a different body (payload swapped after signing)", async () => {
      const signed = push({ marker: "original" });
      const sig = "sha256=" + hex(SITE_SECRET, signed);
      const res = await send({ body: push({ marker: "tampered" }), signature: sig });
      await expectNotDeployed(res, 401);
    });

    it("rejects a signature computed over the body with trailing whitespace removed", async () => {
      const body = push() + "\n";
      const res = await send({ body, signature: "sha256=" + hex(SITE_SECRET, body.trim()) });
      await expectNotDeployed(res, 401);
    });

    it("rejects a GitHub signature that lost its sha256= prefix", async () => {
      const res = await send({ signature: hex(SITE_SECRET, push()), body: push() });
      await expectNotDeployed(res, 401);
    });

    it("rejects other hash algorithms in the signature prefix", async () => {
      const body = push();
      for (const prefix of ["sha1=", "sha512=", "SHA256=", "sha256:", "sha256= ", " sha256="]) {
        const res = await send({ body, signature: prefix + hex(SITE_SECRET, body) });
        await expectNotDeployed(res, 401);
      }
    });

    it("rejects a truncated signature and one with extra bytes", async () => {
      const good = hex(SITE_SECRET, push());
      for (const sig of [good.slice(0, -1), good.slice(0, 32), good + "00", good + good]) {
        const res = await send({ signature: "sha256=" + sig });
        await expectNotDeployed(res, 401);
      }
    });

    it("rejects non-hex characters of the right length", async () => {
      for (const sig of ["z".repeat(64), "!".repeat(64), "g" + "a".repeat(63), " " + "a".repeat(63)]) {
        const res = await send({ signature: "sha256=" + sig });
        await expectNotDeployed(res, 401);
      }
    });

    it("answers 401, not 500, to a signature with non-ASCII characters whose UTF-16 length matches", async () => {
      // 64 chars, but "é" is two bytes in UTF-8, so the byte lengths differ.
      const sig = "sha256=" + "é" + "a".repeat(63);
      const res = await send({ signature: sig });
      await expectNotDeployed(res, 401);
    });

    it("rejects an enormous signature header without crashing", async () => {
      const res = await send({ signature: "sha256=" + "a".repeat(8000) });
      await expectNotDeployed(res, 400, 401, 431);
    });

    it("rejects the all-zero and empty-HMAC signatures", async () => {
      for (const sig of ["sha256=" + "0".repeat(64), "sha256=" + hex("", push())]) {
        const res = await send({ signature: sig });
        await expectNotDeployed(res, 401);
      }
    });

    it("a Gitea signature in uppercase hex is still verified against the real digest", async () => {
      const res = await send({ provider: "gitea", signature: "A".repeat(64) });
      await expectNotDeployed(res, 401);
    });

    it("a GitHub-style prefixed signature does not authenticate a Gitea webhook", async () => {
      const body = push();
      const res = await send({ provider: "gitea", body, signature: "sha256=" + hex(GITEA_SECRET, body) });
      await expectNotDeployed(res, 401);
    });

    it("never records a delivery for a webhook with a bad signature", async () => {
      const id = randomUUID();
      const res = await send({ delivery: id, signature: "sha256=" + "00".repeat(32) });
      expect(res.statusCode).toBe(401);
      expect(deliveryRows(id)).toHaveLength(0);
    });

    it("audits the rejected attempt without storing the signature or the secret", async () => {
      await send({ signature: "sha256=" + "11".repeat(32) });
      const rows = env.db
        .select()
        .from(schema.auditLog)
        .where(and(eq(schema.auditLog.action, "webhook.receive"), eq(schema.auditLog.result, "error")))
        .all();
      expect(rows.length).toBeGreaterThan(0);
      expect(JSON.stringify(rows)).not.toContain(SITE_SECRET);
      expect(JSON.stringify(rows)).not.toContain("1111111111");
    });

    it("never echoes the secret or the expected signature in an error response", async () => {
      const body = push();
      const res = await send({ body, signature: "sha256=" + "22".repeat(32) });
      expect(res.body).not.toContain(SITE_SECRET);
      expect(res.body).not.toContain(hex(SITE_SECRET, body));
    });
  });

  describe("wrong site, provider or target", () => {
    it("a signature valid for site 1 does not work on site 2 (other secret)", async () => {
      const res = await send({ siteId: 2 });
      await expectNotDeployed(res, 401);
    });

    it("a GitHub-signed webhook is refused by the Gitea endpoint of a GitHub site", async () => {
      const body = push();
      const res = await send({ provider: "gitea", siteId: 1, body, signature: hex(SITE_SECRET, body) });
      await expectNotDeployed(res, 404);
    });

    it("a Gitea-signed webhook is refused by the GitHub endpoint of a Gitea site", async () => {
      const body = push();
      const res = await send({ provider: "github", siteId: GITEA_SITE_ID, body, signature: "sha256=" + hex(GITEA_SECRET, body) });
      await expectNotDeployed(res, 404);
    });

    it.each(["999", "0", "-1", "1.5", "1e0", "0x1", " 1", "1 ", "abc", "1;2", "1%00", "1/../2", "99999999999999999999", "NaN", "Infinity"])(
      "site id %j never deploys and never answers 500",
      async (siteId) => {
        const res = await send({ siteId: encodeURIComponent(siteId) === siteId ? siteId : encodeURIComponent(siteId), signature: "sha256=" + "33".repeat(32) });
        expect(res.statusCode).toBeLessThan(500);
        expect(res.statusCode).toBeGreaterThanOrEqual(400);
        await settle();
        expect(deployCalls()).toHaveLength(0);
      },
    );
  });

  describe("replayed delivery id (idempotence)", () => {
    it("the same delivery id is processed only once", async () => {
      const id = randomUUID();
      const first = await send({ delivery: id });
      expect(first.json().status).toBe("accepted");
      await vi.waitFor(() => expect(deployCalls()).toHaveLength(1));

      const second = await send({ delivery: id });
      expect(second.statusCode).toBe(200);
      expect(second.json().status).toBe("already_processed");
      const third = await send({ delivery: id });
      expect(third.json().status).toBe("already_processed");
      await settle();
      expect(deployCalls(), "a replay deployed again").toHaveLength(1);
    });

    it("a replay with a different body but the same delivery id is also ignored", async () => {
      const id = randomUUID();
      await send({ delivery: id });
      await vi.waitFor(() => expect(deployCalls()).toHaveLength(1));
      const other = push({ head_commit: { id: "b".repeat(40), message: "other" } });
      const res = await send({ delivery: id, body: other });
      expect(res.json().status).toBe("already_processed");
      await settle();
      expect(deployCalls()).toHaveLength(1);
    });

    it("a replayed delivery with a bad signature is still rejected, not 'already processed'", async () => {
      const id = randomUUID();
      await send({ delivery: id });
      await vi.waitFor(() => expect(deployCalls()).toHaveLength(1));
      const res = await send({ delivery: id, signature: "sha256=" + "44".repeat(32) });
      expect(res.statusCode).toBe(401);
    });
  });

  describe("malicious (but correctly signed) payloads", () => {
    it("ignores a push to a branch name carrying a shell command", async () => {
      for (const ref of [
        "refs/heads/main; rm -rf /",
        "refs/heads/main\nINJECTED=true",
        "refs/heads/$(whoami)",
        "refs/heads/../../etc/passwd",
        "refs/heads/main/../other",
        "refs/tags/main",
        "main",
        "",
      ]) {
        const res = await send({ body: push({ ref }) });
        await expectNotDeployed(res, 200, 400);
      }
    });

    it("tolerates a ref that is not a string", async () => {
      for (const ref of [null, 1, true, ["refs/heads/main"], { a: 1 }]) {
        const res = await send({ body: push({ ref }) });
        await expectNotDeployed(res, 200, 400);
      }
    });

    it("deploys the repo stored for the site, whatever repository the payload names", async () => {
      const evil = "https://evil.example/x/y; rm -rf /";
      const res = await send({
        body: push({
          repository: { full_name: "x/y; rm -rf /", clone_url: evil, html_url: evil, ssh_url: "git@evil:x/y" },
          repo: evil,
          branch: "main; rm -rf /",
          clone_url: evil,
        }),
      });
      expect(res.statusCode, res.body).toBe(200);
      await vi.waitFor(() => expect(deployCalls()).toHaveLength(1));
      const params = deployCalls()[0][1] as Record<string, unknown>;
      expect(params.repo).toBe("https://github.com/alice/a-repo");
      expect(params.branch).toBe("main");
      expect(JSON.stringify(params)).not.toContain("evil");
      expect(JSON.stringify(params)).not.toContain("rm -rf");
    });

    it("refuses a head_commit id that is not a commit hash", async () => {
      for (const id of [
        "abc1234; rm -rf /",
        "$(whoami)",
        "`id`",
        "--upload-pack=evil",
        "HEAD",
        "main",
        "../../etc",
        "a".repeat(41),
        "XYZ",
        "abc1234\nINJECTED=true",
        { $ne: null },
        ["a".repeat(40)],
        12345,
        true,
      ]) {
        const res = await send({ body: push({ head_commit: { id, message: "m" } }) });
        await expectNotDeployed(res, 400);
      }
    });

    it("never passes the commit message to the agent and truncates what it stores", async () => {
      const message = "<script>alert(1)</script>; rm -rf / `id` $(whoami) " + "x".repeat(5000);
      const res = await send({ body: push({ head_commit: { id: GOOD_SHA, message } }) });
      expect(res.statusCode, res.body).toBe(200);
      await vi.waitFor(() => expect(deployCalls()).toHaveLength(1));
      const params = deployCalls()[0][1] as Record<string, unknown>;
      expect(JSON.stringify(params)).not.toContain("rm -rf");
      await vi.waitFor(() => {
        const row = env.db.select().from(schema.deployments).where(eq(schema.deployments.commitSha, GOOD_SHA)).all().at(-1);
        expect(row).toBeTruthy();
        expect((row!.commitMessage ?? "").length).toBeLessThanOrEqual(500);
      });
    });

    it("ignores a non-string commit message instead of crashing", async () => {
      const res = await send({ body: push({ head_commit: { id: GOOD_SHA, message: { a: 1 } } }) });
      expect(res.statusCode, res.body).toBe(200);
      await vi.waitFor(() => expect(deployCalls()).toHaveLength(1));
    });

    it.each(["null", "[]", '"a string"', "123", "true", "{", "not json", "", "{}", '{"ref":'])(
      "answers a signed body %j without crashing or deploying",
      async (raw) => {
        const res = await send({ body: raw });
        expect(res.statusCode, res.body).toBeLessThan(500);
        await settle();
        expect(deployCalls()).toHaveLength(0);
      },
    );

    it("handles a head_commit that is null", async () => {
      const res = await send({ body: push({ head_commit: null }) });
      expect(res.statusCode, res.body).toBeLessThan(500);
    });

    it("rejects a body over the size limit without crashing", async () => {
      const big = JSON.stringify({ ref: "refs/heads/main", pad: "x".repeat(2 * 1024 * 1024) });
      const res = await send({ body: big });
      expect(res.statusCode).toBe(413);
      expect(res.body).not.toMatch(/FST_ERR|bodyLimit|stack/i);
      await settle();
      expect(deployCalls()).toHaveLength(0);
    });
  });

  describe("event and delivery headers", () => {
    it.each(["ping", "pull_request", "issues", "PUSH", "push ", "push\tx", "", "push; rm -rf /", "release"])(
      "event %j does not deploy",
      async (event) => {
        const res = await send({ event });
        await expectNotDeployed(res, 200, 400);
      },
    );

    it("a webhook with no event header does not deploy", async () => {
      const res = await send({ event: null });
      await expectNotDeployed(res, 200, 400);
    });

    it.each([
      "'; DROP TABLE webhook_deliveries; --",
      "id\r\nX-Injected: true",
      "id\nX-Injected: true",
      "../../etc/passwd",
      "a b",
      "<script>alert(1)</script>",
      "x".repeat(300),
      "$(whoami)",
      "`id`",
    ])("a delivery id of %j is refused", async (delivery) => {
      const res = await send({ delivery });
      await expectNotDeployed(res, 400);
      // And the table survives.
      expect(env.db.select().from(schema.webhookDeliveries).all()).toBeInstanceOf(Array);
    });

    it("response headers never reflect attacker-controlled header values", async () => {
      const res = await send({
        signature: "sha256=" + "55".repeat(32),
        extraHeaders: { "x-forwarded-host": "evil.example", origin: "https://evil.example", "x-injected": "yes" },
      });
      for (const [k, v] of Object.entries(res.headers)) {
        expect(String(v), `header ${k}`).not.toContain("evil.example");
      }
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
      expect(res.headers["x-injected"]).toBeUndefined();
    });
  });

  describe("wrong content type", () => {
    it.each([
      "text/plain",
      "text/html",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/xml",
      "application/octet-stream",
      "application/jsonp",
      "application/vnd.api+json",
    ])("a correctly signed body sent as %s does not deploy", async (contentType) => {
      const res = await send({ contentType });
      await expectNotDeployed(res, 400, 415);
    });

    it("a correctly signed body with no content type does not deploy", async () => {
      const res = await send({ contentType: null });
      await expectNotDeployed(res, 400, 415);
    });

    it("a form-encoded payload= body (legacy GitHub format) is refused", async () => {
      const raw = "payload=" + encodeURIComponent(push());
      const res = await send({ body: raw, contentType: "application/x-www-form-urlencoded", signature: "sha256=" + hex(SITE_SECRET, raw) });
      await expectNotDeployed(res, 400, 415);
    });

    it("errors for a wrong content type are generic JSON", async () => {
      const res = await send({ contentType: "text/html" });
      expect(res.headers["content-type"]).toMatch(/application\/json/);
      expect(res.body).not.toMatch(/FST_ERR|Unsupported Media Type.*text\/html/);
    });
  });

  describe("rate limiting of the public endpoint", () => {
    it("throttles a flood of unsigned requests", async () => {
      const limited = await buildApp({ agentClient: { callAction: env.callAction } as never, skipRateLimit: false });
      try {
        const statuses: number[] = [];
        for (let i = 0; i < 70; i++) {
          const res = await limited.inject({
            method: "POST",
            url: "/hooks/github/1",
            headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "00".repeat(32), "x-github-delivery": randomUUID(), "x-github-event": "push" },
            payload: push(),
          });
          statuses.push(res.statusCode);
        }
        expect(statuses.slice(0, 60).every((s) => s === 401)).toBe(true);
        expect(statuses).toContain(429);
      } finally {
        await limited.close();
      }
    });
  });

  it("the whole barrage deployed nothing it should not have (final state)", async () => {
    // Every forged request above was either rejected or checked individually;
    // here we make sure no stray pending delivery rows exist for bad signatures.
    const unsigned = env.db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.signatureOk, false))
      .all();
    expect(unsigned).toHaveLength(0);
    // The seed value of the zero sha is never used as a commit.
    expect(env.db.select().from(schema.deployments).where(eq(schema.deployments.commitSha, ZERO_SHA)).all()).toHaveLength(0);
  });
});
