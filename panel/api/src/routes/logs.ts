import type { FastifyInstance } from "fastify";
import type { AgentClient } from "../agent/client.js";
import { getDB } from "../db/connection.js";
import { sites, accounts, deployments } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { requireSession, getAccessibleAccountIds } from "../auth/middleware.js";
import { agentErrorResponse } from "../agent/errors.js";
import { isBuildLogPath } from "../validation.js";

interface LogsOpts {
  agentClient: AgentClient;
}

export async function logRoutes(app: FastifyInstance, opts: LogsOpts) {
  const agent = opts.agentClient;

  app.get(
    "/api/sites/:siteId/logs",
    { preHandler: [requireSession] },
    async (request, reply) => {
      const { siteId: siteIdStr } = request.params as { siteId: string };
      const siteId = Number(siteIdStr);
      if (Number.isNaN(siteId)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid site ID" } });
      }

      const query = request.query as { source?: unknown; lines?: unknown };
      const source = query.source ?? "app";
      if (typeof source !== "string" || !["app", "access"].includes(source)) {
        return reply.status(400).send({
          error: { code: "INVALID_SOURCE", message: "source must be app or access" },
        });
      }

      const lines = Math.min(Math.max(Number(query.lines) || 100, 1), 1000);

      const db = getDB();
      const site = db.select().from(sites).where(eq(sites.id, siteId)).get();
      if (!site) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }

      const accountIds = getAccessibleAccountIds(request.session!.user.id, request.session!.user.role);
      if (accountIds && !accountIds.includes(site.accountId)) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
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

      const result = await agent.callAction("logs.tail", {
        account_slug: account.slug,
        domain: site.primaryDomain,
        source,
        lines,
      });

      if (!result.ok) {
        return agentErrorResponse(reply, result);
      }

      return reply.send(result.result);
    },
  );

  app.get(
    "/api/sites/:siteId/deployments/:deployId/log",
    { preHandler: [requireSession] },
    async (request, reply) => {
      const { siteId: siteIdStr, deployId: deployIdStr } = request.params as {
        siteId: string;
        deployId: string;
      };
      const siteId = Number(siteIdStr);
      const deployId = Number(deployIdStr);
      if (Number.isNaN(siteId) || Number.isNaN(deployId)) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid ID" } });
      }

      const query = request.query as { lines?: string };
      const lines = Math.min(Math.max(Number(query.lines) || 200, 1), 1000);

      const db = getDB();
      const site = db.select().from(sites).where(eq(sites.id, siteId)).get();
      if (!site) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Site not found" } });
      }

      const accountIds = getAccessibleAccountIds(request.session!.user.id, request.session!.user.role);
      if (accountIds && !accountIds.includes(site.accountId)) {
        return reply.status(403).send({ error: { code: "FORBIDDEN", message: "Access denied to this account" } });
      }

      const deploy = db
        .select()
        .from(deployments)
        .where(eq(deployments.id, deployId))
        .get();
      if (!deploy || deploy.siteId !== siteId) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Deployment not found" } });
      }

      if (!deploy.logPath) {
        return reply.status(404).send({
          error: { code: "NO_LOG", message: "No build log available for this deployment" },
        });
      }

      // The path comes from our own database, but it ends up in a file read by
      // the privileged agent: refuse anything that is not a plain log path.
      if (!isBuildLogPath(deploy.logPath)) {
        return reply.status(422).send({
          error: { code: "INVALID_LOG_PATH", message: "Stored build log path is not valid" },
        });
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

      const result = await agent.callAction("logs.tail", {
        account_slug: account.slug,
        domain: site.primaryDomain,
        source: "build",
        lines,
        log_path: deploy.logPath,
      });

      if (!result.ok) {
        return agentErrorResponse(reply, result);
      }

      const logResult = result.result as { lines: string[]; count: number };
      return reply.send({
        lines: logResult.lines,
        source: "build",
        deployId,
        count: logResult.count,
      });
    },
  );
}
