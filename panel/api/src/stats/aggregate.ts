import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { getDB } from "../db/connection.js";
import { siteStats } from "../db/schema.js";

export interface TopEntry {
  name: string;
  count: number;
}

export interface DailyAggregate {
  date: string; // YYYY-MM-DD (UTC)
  pageviews: number;
  uniqueVisitors: number;
  topPaths: TopEntry[];
  topReferrers: TopEntry[];
  topCountries: TopEntry[];
}

const TOP_N = 10;
const MAX_KEY_LENGTH = 200;
const ASSET_RE =
  /\.(?:css|js|mjs|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|txt|xml|json)$/i;
const BOT_RE =
  /bot|crawl|spider|slurp|curl\/|wget|python-requests|go-http-client|headless|monitor|uptime|scanner|facebookexternalhit/i;
const COUNTRY_RE = /^[A-Z]{2}$/;

interface ParsedHit {
  date: string;
  path: string;
  ip: string;
  userAgent: string;
  referrerHost: string;
  country: string;
  status: number;
  method: string;
}

function firstHeader(headers: unknown, name: string): string {
  if (!headers || typeof headers !== "object") return "";
  const wanted = name.toLowerCase();
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (k.toLowerCase() !== wanted) continue;
    if (Array.isArray(v)) return typeof v[0] === "string" ? v[0] : "";
    return typeof v === "string" ? v : "";
  }
  return "";
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Accepts Caddy's JSON access log format (nested "request") and a flat variant.
export function parseAccessLine(line: string): ParsedHit | null {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    obj = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const req = (obj.request && typeof obj.request === "object" ? obj.request : {}) as Record<
    string,
    unknown
  >;
  const headers = req.headers ?? obj.headers;

  const ts = obj.ts ?? obj.timestamp;
  let ms: number;
  if (typeof ts === "number") ms = ts < 1e11 ? ts * 1000 : ts;
  else if (typeof ts === "string") ms = Date.parse(ts);
  else return null;
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms).toISOString().slice(0, 10);

  const rawUri = str(req.uri) || str(obj.path) || str(obj.uri);
  if (!rawUri) return null;
  // Query strings may carry personal data: only the path is kept.
  let path = rawUri.split(/[?#]/)[0] ?? "";
  if (!path.startsWith("/")) return null;
  path = path.slice(0, MAX_KEY_LENGTH);

  const status = typeof obj.status === "number" ? obj.status : Number(obj.status);
  if (!Number.isFinite(status)) return null;

  const ip = str(req.remote_ip) || str(req.client_ip) || str(obj.remote_addr) || str(obj.remote_ip);
  const userAgent = firstHeader(headers, "User-Agent") || str(obj.user_agent);
  const referer = firstHeader(headers, "Referer") || str(obj.referer);
  let referrerHost = "";
  if (referer) {
    try {
      referrerHost = new URL(referer).hostname.toLowerCase();
    } catch {
      referrerHost = "";
    }
  }
  const rawCountry = (firstHeader(headers, "Cf-Ipcountry") || str(obj.country)).toUpperCase();
  const country = COUNTRY_RE.test(rawCountry) ? rawCountry : "";

  return {
    date,
    path,
    ip,
    userAgent,
    referrerHost,
    country,
    status,
    method: str(req.method) || str(obj.method) || "GET",
  };
}

function isPageview(hit: ParsedHit): boolean {
  if (hit.method !== "GET") return false;
  if (hit.status < 200 || hit.status >= 400) return false;
  if (ASSET_RE.test(hit.path)) return false;
  if (BOT_RE.test(hit.userAgent)) return false;
  return true;
}

function top(counts: Map<string, number>): TopEntry[] {
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, TOP_N)
    .map(([name, count]) => ({ name, count }));
}

interface DayAcc {
  pageviews: number;
  visitors: Set<string>;
  paths: Map<string, number>;
  referrers: Map<string, number>;
  countries: Map<string, number>;
}

function bump(m: Map<string, number>, key: string): void {
  m.set(key, (m.get(key) ?? 0) + 1);
}

/**
 * Pure aggregation of access log lines into per-day figures.
 * Visitors are counted through a salted hash kept only in memory; the salt is random
 * per call and discarded, so neither IPs nor hashes ever reach the database.
 */
export function aggregateAccessLines(
  lines: string[],
  siteId: number,
  ownHosts: string[] = [],
): DailyAggregate[] {
  const salt = randomBytes(16);
  const own = new Set(ownHosts.map((h) => h.toLowerCase()));
  const days = new Map<string, DayAcc>();

  for (const line of lines) {
    const hit = parseAccessLine(line);
    if (!hit || !isPageview(hit)) continue;

    let acc = days.get(hit.date);
    if (!acc) {
      acc = {
        pageviews: 0,
        visitors: new Set(),
        paths: new Map(),
        referrers: new Map(),
        countries: new Map(),
      };
      days.set(hit.date, acc);
    }

    acc.pageviews++;
    bump(acc.paths, hit.path);
    if (hit.referrerHost && !own.has(hit.referrerHost)) {
      bump(acc.referrers, hit.referrerHost.slice(0, MAX_KEY_LENGTH));
    }
    if (hit.country) bump(acc.countries, hit.country);

    const visitor = createHash("sha256")
      .update(salt)
      .update(`${siteId}|${hit.ip}|${hit.userAgent}`)
      .digest("hex");
    acc.visitors.add(visitor);
  }

  return [...days.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, acc]) => ({
      date,
      pageviews: acc.pageviews,
      uniqueVisitors: acc.visitors.size,
      topPaths: top(acc.paths),
      topReferrers: top(acc.referrers),
      topCountries: top(acc.countries),
    }));
}

/**
 * Upserts aggregates for a site. The access log is read as a tail window with no offset,
 * so re-processing overlaps with earlier runs: a stored day is only replaced when the new
 * figure is not lower (a window that starts mid-day can only under-count that day).
 */
export function upsertSiteStats(siteId: number, aggregates: DailyAggregate[]): number {
  const db = getDB();
  let written = 0;
  for (const agg of aggregates) {
    const existing = db
      .select()
      .from(siteStats)
      .where(and(eq(siteStats.siteId, siteId), eq(siteStats.date, agg.date)))
      .get();
    if (existing && existing.pageviews > agg.pageviews) continue;

    const values = {
      pageviews: agg.pageviews,
      uniqueVisitors: agg.uniqueVisitors,
      topPaths: JSON.stringify(agg.topPaths),
      topReferrers: JSON.stringify(agg.topReferrers),
      topCountries: JSON.stringify(agg.topCountries),
    };
    if (existing) {
      db.update(siteStats).set(values).where(eq(siteStats.id, existing.id)).run();
    } else {
      db.insert(siteStats).values({ siteId, date: agg.date, ...values }).run();
    }
    written++;
  }
  return written;
}
