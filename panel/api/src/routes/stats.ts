import type { FastifyInstance } from "fastify";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import type { AgentClient } from "../agent/client.js";
import { getDB } from "../db/connection.js";
import { accounts, siteStats, sites } from "../db/schema.js";
import {
  requireSession,
  requireCSRF,
  requireAdmin,
  getAccessibleAccountIds,
} from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";
import { aggregateAccessLines, upsertSiteStats } from "../stats/aggregate.js";
import { agentErrorCode, agentErrorResponse } from "../agent/errors.js";

interface StatsOpts {
  agentClient: AgentClient;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_RANGE_DAYS = 30;
const MAX_RANGE_DAYS = 400;
const DAY_MS = 86_400_000;

function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function parseJsonList(raw: string): unknown[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function parseSiteId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function statsRoutes(app: FastifyInstance, opts: StatsOpts) {
  const agent = opts.agentClient;

  app.get(
    "/api/sites/:siteId/stats",
    { preHandler: [requireSession] },
    async (request, reply) => {
      const siteId = parseSiteId((request.params as { siteId: string }).siteId);
      if (!siteId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid site ID" } });
      }

      const query = request.query as { from?: string; to?: string };
      const today = new Date();
      const to = query.to ?? today.toISOString().slice(0, 10);
      const from =
        query.from ??
        new Date(Date.parse(`${to}T00:00:00Z`) - (DEFAULT_RANGE_DAYS - 1) * DAY_MS)
          .toISOString()
          .slice(0, 10);
      if (!isValidDate(from) || !isValidDate(to) || from > to) {
        return reply.status(400).send({
          error: { code: "INVALID_RANGE", message: "from and to must be YYYY-MM-DD with from <= to" },
        });
      }
      if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS >= MAX_RANGE_DAYS) {
        return reply.status(400).send({
          error: { code: "RANGE_TOO_LARGE", message: `Range cannot exceed ${MAX_RANGE_DAYS} days` },
        });
      }

      const db = getDB();
      const site = db.select().from(sites).where(eq(sites.id, siteId)).get();
      if (!site) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }

      const accountIds = getAccessibleAccountIds(request.session!.user.id, request.session!.user.role);
      if (accountIds && !accountIds.includes(site.accountId)) {
        return reply
          .status(403)
          .send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
      }

      const rows = db
        .select()
        .from(siteStats)
        .where(and(eq(siteStats.siteId, siteId), gte(siteStats.date, from), lte(siteStats.date, to)))
        .orderBy(asc(siteStats.date))
        .all();

      const days = rows.map((r) => ({
        date: r.date,
        pageviews: r.pageviews,
        uniqueVisitors: r.uniqueVisitors,
        topPaths: parseJsonList(r.topPaths),
        topReferrers: parseJsonList(r.topReferrers),
        topCountries: parseJsonList(r.topCountries),
      }));

      return {
        siteId,
        from,
        to,
        totals: {
          pageviews: days.reduce((n, d) => n + d.pageviews, 0),
          // Sum of daily uniques: a visitor on two days counts twice (no cross-day identity is kept).
          uniqueVisitors: days.reduce((n, d) => n + d.uniqueVisitors, 0),
        },
        days,
      };
    },
  );

  app.post(
    "/api/sites/:siteId/stats/refresh",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const siteId = parseSiteId((request.params as { siteId: string }).siteId);
      if (!siteId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid site ID" } });
      }

      const db = getDB();
      const site = db.select().from(sites).where(eq(sites.id, siteId)).get();
      if (!site) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }
      const account = db.select().from(accounts).where(eq(accounts.id, site.accountId)).get();
      if (!account) {
        return reply
          .status(500)
          .send({ error: { code: "ACCOUNT_MISSING", message: "Account not found" } });
      }

      const userId = request.session!.user.id;
      const audit = (result: "ok" | "error", errorCode?: string) =>
        logAudit({
          actorUserId: userId,
          actorKind: "user",
          action: "stats.refresh",
          targetType: "site",
          targetId: String(siteId),
          result,
          errorCode,
        });

      if (!site.statsEnabled) {
        audit("error", "STATS_DISABLED");
        return reply
          .status(409)
          .send({ error: { code: "STATS_DISABLED", message: "Statistics are disabled for this site" } });
      }

      const result = await agent.callAction("logs.tail", {
        account_slug: account.slug,
        domain: site.primaryDomain,
        source: "access",
        lines: 1000,
      });
      if (!result.ok) {
        audit("error", agentErrorCode(result));
        return agentErrorResponse(reply, result);
      }

      const lines = (result.result as { lines?: unknown })?.lines;
      const logLines = Array.isArray(lines) ? lines.filter((l): l is string => typeof l === "string") : [];
      const aggregates = aggregateAccessLines(logLines, siteId, [site.primaryDomain]);
      const updated = upsertSiteStats(siteId, aggregates);

      audit("ok");
      return { siteId, processedLines: logLines.length, daysUpdated: updated };
    },
  );
}
