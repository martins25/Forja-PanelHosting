import type { FastifyInstance } from "fastify";
import { eq, and, desc, inArray } from "drizzle-orm";
import type { AgentClient } from "../agent/client.js";
import { getDB } from "../db/connection.js";
import {
  removalRequests,
  sites,
  accounts,
  domains,
  users,
} from "../db/schema.js";
import {
  requireSession,
  requireCSRF,
  requireAdmin,
  getAccessibleAccountIds,
} from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";
import { buildCaddySyncPayload } from "./sites.js";
import { agentErrorResponse } from "../agent/errors.js";

interface RemovalRequestsOpts {
  agentClient: AgentClient;
}

const MAX_REASON_LENGTH = 1000;
const REVIEW_STATUSES = ["done", "rejected"] as const;
const LIST_STATUSES = ["open", "done", "rejected"] as const;

function parseId(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function removalRequestRoutes(
  app: FastifyInstance,
  opts: RemovalRequestsOpts,
) {
  const agent = opts.agentClient;

  // A client (or admin) asks for a site to be taken down.
  app.post(
    "/api/sites/:siteId/removal-request",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      const siteId = parseId((request.params as { siteId: string }).siteId);
      if (!siteId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid site ID" } });
      }

      const body = (request.body ?? {}) as { reason?: unknown };
      let reason: string | null = null;
      if (body.reason !== undefined && body.reason !== null) {
        if (typeof body.reason !== "string" || body.reason.length > MAX_REASON_LENGTH) {
          return reply.status(400).send({
            error: {
              code: "INVALID_BODY",
              message: `reason must be a string of at most ${MAX_REASON_LENGTH} characters`,
            },
          });
        }
        reason = body.reason.trim() || null;
      }

      const db = getDB();
      const site = db.select().from(sites).where(eq(sites.id, siteId)).get();
      if (!site) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }

      const user = request.session!.user;
      const accountIds = getAccessibleAccountIds(user.id, user.role);
      if (accountIds && !accountIds.includes(site.accountId)) {
        return reply
          .status(403)
          .send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
      }

      const existing = db
        .select()
        .from(removalRequests)
        .where(
          and(
            eq(removalRequests.siteId, siteId),
            eq(removalRequests.status, "open"),
          ),
        )
        .get();
      if (existing) {
        return reply.status(409).send({
          error: {
            code: "REQUEST_ALREADY_OPEN",
            message: "There is already an open removal request for this site",
          },
        });
      }

      const row = db
        .insert(removalRequests)
        .values({
          siteId,
          requestedBy: user.id,
          reason,
          status: "open",
          createdAt: new Date().toISOString(),
        })
        .returning()
        .get();

      logAudit({
        actorUserId: user.id,
        actorKind: "user",
        action: "removal_request.create",
        targetType: "site",
        targetId: String(siteId),
        result: "ok",
      });

      return reply.status(201).send(row);
    },
  );

  // Admin sees every request; a client only those of their own accounts.
  app.get(
    "/api/removal-requests",
    { preHandler: [requireSession] },
    async (request, reply) => {
      const { status } = request.query as { status?: string };
      if (
        status !== undefined &&
        !(LIST_STATUSES as readonly string[]).includes(status)
      ) {
        return reply.status(400).send({
          error: { code: "INVALID_QUERY", message: "status must be open, done or rejected" },
        });
      }

      const user = request.session!.user;
      const accountIds = getAccessibleAccountIds(user.id, user.role);
      if (accountIds && accountIds.length === 0) return [];

      const db = getDB();
      const conditions = [];
      if (accountIds) conditions.push(inArray(sites.accountId, accountIds));
      if (status) {
        conditions.push(
          eq(removalRequests.status, status as (typeof LIST_STATUSES)[number]),
        );
      }

      const rows = db
        .select({
          id: removalRequests.id,
          siteId: removalRequests.siteId,
          accountId: sites.accountId,
          accountSlug: accounts.slug,
          domain: sites.primaryDomain,
          requestedBy: removalRequests.requestedBy,
          requestedByEmail: users.email,
          reason: removalRequests.reason,
          status: removalRequests.status,
          createdAt: removalRequests.createdAt,
          reviewedBy: removalRequests.reviewedBy,
          reviewedAt: removalRequests.reviewedAt,
        })
        .from(removalRequests)
        .innerJoin(sites, eq(removalRequests.siteId, sites.id))
        .innerJoin(accounts, eq(sites.accountId, accounts.id))
        .innerJoin(users, eq(removalRequests.requestedBy, users.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(removalRequests.id))
        .all();

      return rows;
    },
  );

  // Admin resolves a request: "done" disables the site, "rejected" leaves it as is.
  app.patch(
    "/api/removal-requests/:id",
    { preHandler: [requireSession, requireCSRF, requireAdmin] },
    async (request, reply) => {
      const id = parseId((request.params as { id: string }).id);
      if (!id) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid request ID" } });
      }

      const body = (request.body ?? {}) as { status?: unknown };
      if (
        typeof body.status !== "string" ||
        !(REVIEW_STATUSES as readonly string[]).includes(body.status)
      ) {
        return reply.status(400).send({
          error: { code: "INVALID_BODY", message: "status must be done or rejected" },
        });
      }
      const newStatus = body.status as (typeof REVIEW_STATUSES)[number];

      const db = getDB();
      const req = db
        .select()
        .from(removalRequests)
        .where(eq(removalRequests.id, id))
        .get();
      if (!req) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Removal request not found" } });
      }
      if (req.status !== "open") {
        return reply.status(409).send({
          error: { code: "ALREADY_REVIEWED", message: "Request was already reviewed" },
        });
      }

      const adminId = request.session!.user.id;

      if (newStatus === "done") {
        const site = db.select().from(sites).where(eq(sites.id, req.siteId)).get();
        if (!site) {
          return reply
            .status(404)
            .send({ error: { code: "NOT_FOUND", message: "Site not found" } });
        }
        const account = db
          .select()
          .from(accounts)
          .where(eq(accounts.id, site.accountId))
          .get();
        if (!account) {
          return reply
            .status(500)
            .send({ error: { code: "ACCOUNT_MISSING", message: "Account not found" } });
        }

        if (site.mode !== "disabled") {
          const res = await agent.callAction("site.set_mode", {
            account_slug: account.slug,
            domain: site.primaryDomain,
            mode: "disabled",
          });
          if (!res.ok) {
            logAudit({
              actorUserId: adminId,
              actorKind: "user",
              action: "removal_request.review",
              targetType: "removal_request",
              targetId: String(id),
              result: "error",
              errorCode: res.error?.code ?? "AGENT_ERROR",
            });
            return agentErrorResponse(reply, res);
          }

          db.update(sites)
            .set({ mode: "disabled" })
            .where(eq(sites.id, site.id))
            .run();

          const allSitesRows = db
            .select()
            .from(sites)
            .innerJoin(accounts, eq(sites.accountId, accounts.id))
            .all();
          const allDomains = db.select().from(domains).all();
          await agent.callAction("caddy.sync", {
            sites: buildCaddySyncPayload(allSitesRows, allDomains),
            panel_port: 7000,
          });
        }
      }

      const updated = db
        .update(removalRequests)
        .set({
          status: newStatus,
          reviewedBy: adminId,
          reviewedAt: new Date().toISOString(),
        })
        .where(eq(removalRequests.id, id))
        .returning()
        .get();

      logAudit({
        actorUserId: adminId,
        actorKind: "user",
        action: "removal_request.review",
        targetType: "removal_request",
        targetId: String(id),
        paramsRedacted: JSON.stringify({ status: newStatus, site_id: req.siteId }),
        result: "ok",
      });

      return updated;
    },
  );
}
