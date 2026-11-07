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
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";

let sqlite: InstanceType<typeof Database>;

function accessLine(opts: {
  ts: string;
  uri?: string;
  ip?: string;
  ua?: string;
  referer?: string;
  country?: string;
  status?: number;
  method?: string;
}): string {
  const headers: Record<string, string[]> = {
    "User-Agent": [opts.ua ?? "Mozilla/5.0 Firefox/130"],
  };
  if (opts.referer) headers["Referer"] = [opts.referer];
  if (opts.country) headers["Cf-Ipcountry"] = [opts.country];
  return JSON.stringify({
    ts: Date.parse(opts.ts) / 1000,
    status: opts.status ?? 200,
    request: {
      remote_ip: opts.ip ?? "203.0.113.1",
      method: opts.method ?? "GET",
      uri: opts.uri ?? "/",
      headers,
    },
  });
}

describe("site stats routes", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let mockCallAction: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    setAppKeyForTest(randomBytes(32));
    sqlite = new Database(":memory:");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    vi.mocked(getDB).mockReturnValue(db);
    configureAccess({ teamDomain: "test.cloudflareaccess.com", audience: "test-aud" });

    const hash = await hashPassword("password123");
    for (const [email, role] of [
      ["admin@forja.dev", "admin"],
      ["client1@forja.dev", "client"],
      ["client2@forja.dev", "client"],
    ] as const) {
      db.insert(schema.users)
        .values({ email, role, passwordHash: hash, createdAt: new Date().toISOString() })
        .run();
    }
    db.insert(schema.plans)
      .values({ name: "Basic", cpuMillis: 1000, memoryMb: 512, diskMb: 5000, maxSites: 5, maxDatabases: 3 })
      .run();
    for (const [i, slug] of ["acct1", "acct2"].entries()) {
      db.insert(schema.accounts)
        .values({
          slug,
          linuxUser: `fj-${slug}`,
          uid: 1001 + i,
          planId: 1,
          status: "active",
          createdAt: new Date().toISOString(),
        })
        .run();
      db.insert(schema.sites)
        .values({
          accountId: i + 1,
          primaryDomain: `${slug}.example.com`,
          runtime: "node",
          runtimeVersion: "22",
          source: "github",
          repo: "https://github.com/user/repo",
          branch: "main",
          installCmd: "npm ci",
          startCmd: "npm start",
          internalPort: 10000 + i,
          mode: "online",
        })
        .run();
    }
    // client1 -> account 1, client2 -> account 2
    db.insert(schema.userAccounts).values({ userId: 2, accountId: 1 }).run();
    db.insert(schema.userAccounts).values({ userId: 3, accountId: 2 }).run();

    db.insert(schema.siteStats)
      .values([
        {
          siteId: 1,
          date: "2026-11-01",
          pageviews: 10,
          uniqueVisitors: 4,
          topPaths: JSON.stringify([{ name: "/", count: 6 }]),
          topReferrers: JSON.stringify([{ name: "news.example.org", count: 2 }]),
          topCountries: "[]",
        },
        { siteId: 1, date: "2026-11-02", pageviews: 5, uniqueVisitors: 3 },
        { siteId: 2, date: "2026-11-01", pageviews: 99, uniqueVisitors: 50 },
      ])
      .run();

    mockCallAction = vi.fn();
  });

  afterEach(() => {
    sqlite.close();
    clearAppKey();
    clearVerifierForTest();
    resetAccess();
    vi.restoreAllMocks();
  });

  async function getApp() {
    return buildApp({
      agentClient: { callAction: mockCallAction } as never,
      skipRateLimit: true,
    });
  }

  async function login(app: Awaited<ReturnType<typeof getApp>>, email: string) {
    setVerifierForTest(async () => ({ email, sub: "u" }));
    const res = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "cf-access-jwt-assertion": "token" },
      payload: { password: "password123" },
    });
    const cookies = res.headers["set-cookie"];
    return {
      cookie: Array.isArray(cookies) ? cookies.join("; ") : (cookies ?? ""),
      csrf: res.json().csrfToken as string,
    };
  }

  it("requires a session", async () => {
    const app = await getApp();
    const res = await app.inject({ method: "GET", url: "/api/sites/1/stats" });
    expect(res.statusCode).toBe(401);
  });

  it("returns aggregates for the requested range", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "admin@forja.dev");
    const res = await app.inject({
      method: "GET",
      url: "/api/sites/1/stats?from=2026-11-01&to=2026-11-30",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.days).toHaveLength(2);
    expect(body.days[0].date).toBe("2026-11-01");
    expect(body.days[0].topPaths).toEqual([{ name: "/", count: 6 }]);
    expect(body.days[0].topReferrers).toEqual([{ name: "news.example.org", count: 2 }]);
    expect(body.totals).toEqual({ pageviews: 15, uniqueVisitors: 7 });
  });

  it("respects the date range boundaries", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "admin@forja.dev");
    const res = await app.inject({
      method: "GET",
      url: "/api/sites/1/stats?from=2026-11-02&to=2026-11-02",
      headers: { cookie },
    });
    expect(res.json().days.map((d: { date: string }) => d.date)).toEqual(["2026-11-02"]);
  });

  it("returns an empty list for a range without data", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "admin@forja.dev");
    const res = await app.inject({
      method: "GET",
      url: "/api/sites/1/stats?from=2025-01-01&to=2025-01-31",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().days).toEqual([]);
    expect(res.json().totals).toEqual({ pageviews: 0, uniqueVisitors: 0 });
  });

  it("rejects malformed or inverted ranges", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "admin@forja.dev");
    for (const q of [
      "from=nope&to=2026-11-01",
      "from=2026-11-05&to=2026-11-01",
      "from=2026-02-30&to=2026-03-01",
      "from=2020-01-01&to=2026-11-01",
    ]) {
      const res = await app.inject({
        method: "GET",
        url: `/api/sites/1/stats?${q}`,
        headers: { cookie },
      });
      expect(res.statusCode, q).toBe(400);
    }
  });

  it("returns 404 for an unknown site", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "admin@forja.dev");
    const res = await app.inject({ method: "GET", url: "/api/sites/999/stats", headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it("a client sees the stats of their own site", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client1@forja.dev");
    const res = await app.inject({
      method: "GET",
      url: "/api/sites/1/stats?from=2026-11-01&to=2026-11-30",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totals.pageviews).toBe(15);
  });

  it("a client cannot read the stats of another client's site", async () => {
    const app = await getApp();
    const { cookie } = await login(app, "client1@forja.dev");
    const res = await app.inject({
      method: "GET",
      url: "/api/sites/2/stats?from=2026-11-01&to=2026-11-30",
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).not.toContain("99");
  });

  describe("POST /api/sites/:siteId/stats/refresh", () => {
    it("aggregates the access log and stores the result without IPs", async () => {
      mockCallAction.mockResolvedValue({
        ok: true,
        result: {
          source: "access",
          count: 6,
          lines: [
            accessLine({ ts: "2026-11-03T10:00:00Z", uri: "/", ip: "203.0.113.1", country: "ES" }),
            accessLine({
              ts: "2026-11-03T10:05:00Z",
              uri: "/about?token=secret",
              ip: "203.0.113.2",
              referer: "https://news.example.org/post",
              country: "ES",
            }),
            // same visitor again
            accessLine({ ts: "2026-11-03T11:00:00Z", uri: "/", ip: "203.0.113.1" }),
            // ignored: asset, bot, POST, error
            accessLine({ ts: "2026-11-03T11:01:00Z", uri: "/app.css" }),
            accessLine({ ts: "2026-11-03T11:02:00Z", ua: "Googlebot/2.1" }),
            accessLine({ ts: "2026-11-03T11:03:00Z", method: "POST" }),
            accessLine({ ts: "2026-11-03T11:04:00Z", status: 500 }),
            "not json at all",
          ],
        },
      });

      const app = await getApp();
      const s = await login(app, "admin@forja.dev");
      const res = await app.inject({
        method: "POST",
        url: "/api/sites/1/stats/refresh",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().daysUpdated).toBe(1);
      expect(mockCallAction).toHaveBeenCalledWith("logs.tail", {
        account_slug: "acct1",
        domain: "acct1.example.com",
        source: "access",
        lines: 1000,
      });

      const row = db
        .select()
        .from(schema.siteStats)
        .all()
        .find((r) => r.siteId === 1 && r.date === "2026-11-03")!;
      expect(row.pageviews).toBe(3);
      expect(row.uniqueVisitors).toBe(2);
      expect(JSON.parse(row.topPaths)).toEqual([
        { name: "/", count: 2 },
        { name: "/about", count: 1 },
      ]);
      expect(JSON.parse(row.topReferrers)).toEqual([{ name: "news.example.org", count: 1 }]);
      expect(JSON.parse(row.topCountries)).toEqual([{ name: "ES", count: 2 }]);
      expect(JSON.stringify(row)).not.toContain("203.0.113");
      expect(JSON.stringify(row)).not.toContain("secret");

      const audit = db.select().from(schema.auditLog).all();
      expect(audit.some((a) => a.action === "stats.refresh" && a.result === "ok")).toBe(true);
    });

    it("is idempotent and never lowers an existing day", async () => {
      const lines = [
        accessLine({ ts: "2026-11-01T10:00:00Z" }),
        accessLine({ ts: "2026-11-01T10:01:00Z", ip: "203.0.113.9" }),
      ];
      mockCallAction.mockResolvedValue({ ok: true, result: { lines } });
      const app = await getApp();
      const s = await login(app, "admin@forja.dev");
      const post = () =>
        app.inject({
          method: "POST",
          url: "/api/sites/1/stats/refresh",
          headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
        });
      // Seed day 2026-11-01 has 10 pageviews; the log window only has 2 -> kept.
      expect((await post()).json().daysUpdated).toBe(0);
      const rows = db.select().from(schema.siteStats).all().filter((r) => r.siteId === 1);
      expect(rows.find((r) => r.date === "2026-11-01")!.pageviews).toBe(10);

      // A fresh day twice does not double count.
      mockCallAction.mockResolvedValue({
        ok: true,
        result: { lines: [accessLine({ ts: "2026-11-04T10:00:00Z" })] },
      });
      await post();
      await post();
      const day = db.select().from(schema.siteStats).all().find((r) => r.siteId === 1 && r.date === "2026-11-04")!;
      expect(day.pageviews).toBe(1);
    });

    it("propagates agent failures as 502", async () => {
      mockCallAction.mockResolvedValue({ ok: false, error: { code: "INTERNAL", message: "boom" } });
      const app = await getApp();
      const s = await login(app, "admin@forja.dev");
      const res = await app.inject({
        method: "POST",
        url: "/api/sites/1/stats/refresh",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
      });
      expect(res.statusCode).toBe(502);
    });

    it("is refused when stats are disabled for the site", async () => {
      db.update(schema.sites).set({ statsEnabled: false }).run();
      const app = await getApp();
      const s = await login(app, "admin@forja.dev");
      const res = await app.inject({
        method: "POST",
        url: "/api/sites/1/stats/refresh",
        headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
      });
      expect(res.statusCode).toBe(409);
      expect(mockCallAction).not.toHaveBeenCalled();
    });

    it("is forbidden for clients, including on their own site", async () => {
      const app = await getApp();
      const s = await login(app, "client1@forja.dev");
      for (const id of [1, 2]) {
        const res = await app.inject({
          method: "POST",
          url: `/api/sites/${id}/stats/refresh`,
          headers: { cookie: s.cookie, "x-csrf-token": s.csrf },
        });
        expect(res.statusCode).toBe(403);
      }
      expect(mockCallAction).not.toHaveBeenCalled();
    });

    it("requires a CSRF token", async () => {
      const app = await getApp();
      const s = await login(app, "admin@forja.dev");
      const res = await app.inject({
        method: "POST",
        url: "/api/sites/1/stats/refresh",
        headers: { cookie: s.cookie },
      });
      expect(res.statusCode).toBe(403);
      expect(mockCallAction).not.toHaveBeenCalled();
    });
  });
});
