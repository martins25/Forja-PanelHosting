// Shared fixture for the abuse-*.test.ts files (not a test itself).
//
// Every abuse test file must declare, before importing this module:
//   vi.mock("../db/connection.js", () => ({ getDB: vi.fn() }));
// so that getDB() returns the in-memory database created here.
//
// World:
//   users     1 admin | 2 clientA (owns acct1) | 3 clientB (owns acct2)
//   accounts  1 acct1 | 2 acct2
//   sites     1 (acct1, a.example.com) | 2 (acct2, b.example.com)
// and one row of every other resource type for each account. Resources of
// client B carry recognisable markers (see MARKERS) so a test can prove that a
// response never leaked them.
import { vi, type Mock } from "vitest";
import type { LightMyRequestResponse } from "fastify";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import { getDB } from "../db/connection.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

/** Strings that exist only in client B's data. */
export const MARKERS = {
  domain: "b-private.example.com",
  repo: "https://github.com/bob/b-private-repo",
  envKey: "B_PRIVATE_KEY",
  envValue: "b-private-env-value-9f31",
  dbName: "bprivatedb",
  dbUser: "bprivateuser",
  logPath: "/srv/forja/accounts/acct2/sites/b-private.example.com/logs/build-b.log",
  reason: "b-private-removal-reason",
  email: "b-private-alert@bob.example",
  commitMessage: "b-private-commit-message",
  webhookSecret: "b-private-webhook-secret-77",
} as const;

export const PASSWORDS = {
  admin: "adminpass-123",
  clientA: "clientApass-1",
  clientB: "clientBpass-1",
} as const;

export const EMAILS = {
  admin: "admin@forja.dev",
  clientA: "alice@forja.dev",
  clientB: "bob@forja.dev",
} as const;

export type Who = "admin" | "clientA" | "clientB";

export interface Auth {
  cookie: string;
  csrf: string;
}

export interface AbuseEnv {
  db: ReturnType<typeof drizzle<typeof schema>>;
  app: Awaited<ReturnType<typeof buildApp>>;
  callAction: Mock;
  fetchMock: Mock;
  auth: Record<Who, Auth>;
  /** Authenticated request as one of the seeded users. */
  as: (
    who: Who,
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) => Promise<LightMyRequestResponse>;
  close: () => Promise<void>;
}

export async function createAbuseEnv(): Promise<AbuseEnv> {
  setAppKeyForTest(randomBytes(32));
  setSecretKeyForTest(randomBytes(32));

  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  vi.mocked(getDB).mockReturnValue(db);

  configureAccess({ teamDomain: "test.cloudflareaccess.com", audience: "test-aud" });

  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ sha: "abc1234567890abc1234567890abc1234567890a" }),
  });
  vi.stubGlobal("fetch", fetchMock);

  const callAction = vi.fn().mockResolvedValue({ ok: true, result: {} });
  const now = new Date().toISOString();

  // --- users ---
  const hashes = {
    admin: await hashPassword(PASSWORDS.admin),
    clientA: await hashPassword(PASSWORDS.clientA),
    clientB: await hashPassword(PASSWORDS.clientB),
  };
  db.insert(schema.users).values([
    { email: EMAILS.admin, role: "admin", passwordHash: hashes.admin, createdAt: now },
    { email: EMAILS.clientA, role: "client", passwordHash: hashes.clientA, createdAt: now },
    { email: EMAILS.clientB, role: "client", passwordHash: hashes.clientB, createdAt: now },
  ]).run();

  db.insert(schema.plans).values({
    name: "Basic", cpuMillis: 1000, memoryMb: 512, diskMb: 5000, maxSites: 50, maxDatabases: 50,
  }).run();

  // --- cloudflare connection of B (a client-managed resource) ---
  db.insert(schema.cfConnections).values({
    name: "bob-cf",
    ownerUserId: 3,
    cfAccountId: "b".repeat(32),
    apiTokenEnc: encryptSecret("cf-token-of-bob-aaaaaaaaaaaaaaaa"),
    tunnelId: "11111111-2222-3333-4444-555555555555",
    tunnelTokenEnc: encryptSecret("tunnel-token-of-bob"),
    managedBy: "client",
  }).run();

  // --- accounts ---
  db.insert(schema.accounts).values([
    { slug: "acct1", linuxUser: "fj-acct1", uid: 1001, planId: 1, status: "active", createdAt: now },
    { slug: "acct2", linuxUser: "fj-acct2", uid: 1002, planId: 1, status: "active", createdAt: now, cfConnectionId: 1 },
  ]).run();
  db.insert(schema.userAccounts).values([
    { userId: 2, accountId: 1 },
    { userId: 3, accountId: 2 },
  ]).run();

  // --- git integrations (owned) ---
  db.insert(schema.gitIntegrations).values([
    { provider: "github", ownerUserId: 2, credentialsEnc: encryptSecret("ghp_alice_token_1234"), webhookSecretEnc: encryptSecret("whs-a") },
    { provider: "github", ownerUserId: 3, credentialsEnc: encryptSecret("ghp_bob_token_5678"), webhookSecretEnc: encryptSecret("whs-b") },
  ]).run();

  // --- sites ---
  db.insert(schema.sites).values([
    {
      accountId: 1, primaryDomain: "a.example.com", runtime: "node", runtimeVersion: "22",
      source: "github", repo: "https://github.com/alice/a-repo", branch: "main", internalPort: 10000,
      webhookSecretEnc: encryptSecret("secret-of-site-a"), autodeploy: true, createdAt: now,
    },
    {
      accountId: 2, primaryDomain: MARKERS.domain, runtime: "node", runtimeVersion: "22",
      source: "github", repo: MARKERS.repo, branch: "main", internalPort: 10002,
      webhookSecretEnc: encryptSecret(MARKERS.webhookSecret), autodeploy: true, createdAt: now,
    },
  ]).run();
  db.insert(schema.domains).values([
    { siteId: 1, hostname: "a.example.com", kind: "primary" },
    { siteId: 2, hostname: MARKERS.domain, kind: "primary" },
  ]).run();

  // --- env vars ---
  db.insert(schema.envVars).values([
    { siteId: 1, key: "A_KEY", valueEnc: encryptSecret("a-value") },
    { siteId: 2, key: MARKERS.envKey, valueEnc: encryptSecret(MARKERS.envValue) },
  ]).run();

  // --- deployments ---
  db.insert(schema.deployments).values([
    { siteId: 1, commitSha: "a".repeat(40), trigger: "manual", status: "succeeded", startedAt: now, finishedAt: now, logPath: "/srv/forja/accounts/acct1/sites/a.example.com/logs/build-a.log" },
    { siteId: 2, commitSha: "b".repeat(40), commitMessage: MARKERS.commitMessage, trigger: "manual", status: "succeeded", startedAt: now, finishedAt: now, logPath: MARKERS.logPath },
  ]).run();

  // --- databases ---
  db.insert(schema.databases).values([
    { accountId: 1, engine: "postgres", name: "adb", dbUser: "auser", passwordEnc: encryptSecret("a-db-pass") },
    { accountId: 2, engine: "postgres", name: MARKERS.dbName, dbUser: MARKERS.dbUser, passwordEnc: encryptSecret("b-db-pass-secret") },
  ]).run();

  // --- backups ---
  db.insert(schema.backups).values([
    { accountId: 1, kind: "snapshot", resticSnapshotId: "aaaaaaaa11", includes: "all", status: "completed", createdAt: now },
    { accountId: 2, kind: "snapshot", resticSnapshotId: "bbbbbbbb22", includes: "all", status: "completed", createdAt: now },
  ]).run();

  // --- certificates / stats ---
  db.insert(schema.certificates).values([
    { siteId: 1, domain: "a.example.com", status: "active" },
    { siteId: 2, domain: MARKERS.domain, status: "active" },
  ]).run();
  db.insert(schema.siteStats).values([
    { siteId: 1, date: now.slice(0, 10), pageviews: 10, uniqueVisitors: 5, topPaths: "[]", topReferrers: "[]", topCountries: "[]" },
    { siteId: 2, date: now.slice(0, 10), pageviews: 777, uniqueVisitors: 333, topPaths: JSON.stringify([{ path: "/b-secret-path", views: 1 }]), topReferrers: "[]", topCountries: "[]" },
  ]).run();

  // --- removal requests ---
  db.insert(schema.removalRequests).values([
    { siteId: 1, requestedBy: 2, reason: "a-reason", status: "open", createdAt: now },
    { siteId: 2, requestedBy: 3, reason: MARKERS.reason, status: "open", createdAt: now },
  ]).run();

  // --- alerts ---
  db.insert(schema.alertChannels).values([
    { userId: 2, kind: "email", config: JSON.stringify({ address: "alice@alice.example" }), enabled: true },
    { userId: 3, kind: "email", config: JSON.stringify({ address: MARKERS.email }), enabled: true },
  ]).run();
  db.insert(schema.alertRules).values([
    { userId: 2, event: "site_down", channelId: 1 },
    { userId: 3, event: "site_down", channelId: 2 },
  ]).run();

  const app = await buildApp({
    agentClient: { callAction } as never,
    skipRateLimit: true,
  });

  // --- log both clients and the admin in once ---
  async function login(email: string, password: string): Promise<Auth> {
    setVerifierForTest(async () => ({ email, sub: email }));
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "cf-access-jwt-assertion": "token" },
      payload: { password },
    });
    if (res.statusCode !== 200) {
      throw new Error(`fixture login failed for ${email}: ${res.statusCode} ${res.body}`);
    }
    return { cookie: res.headers["set-cookie"] as string, csrf: res.json().csrfToken };
  }
  const auth: Record<Who, Auth> = {
    admin: await login(EMAILS.admin, PASSWORDS.admin),
    clientA: await login(EMAILS.clientA, PASSWORDS.clientA),
    clientB: await login(EMAILS.clientB, PASSWORDS.clientB),
  };

  const as: AbuseEnv["as"] = (who, method, url, payload, headers) => {
    const a = auth[who];
    const h: Record<string, string> = { cookie: a.cookie, ...headers };
    if (method !== "GET") h["x-csrf-token"] = a.csrf;
    return app.inject({ method, url, headers: h, payload: payload as never });
  };

  return {
    db,
    app,
    callAction,
    fetchMock,
    auth,
    as,
    close: async () => {
      await app.close();
      sqlite.close();
      clearAppKey();
      clearSecretKey();
      clearVerifierForTest();
      resetAccess();
      vi.unstubAllGlobals();
    },
  };
}
