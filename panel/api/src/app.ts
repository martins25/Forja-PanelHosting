import Fastify, { type FastifyError } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import type { AgentClient } from "./agent/client.js";
import { systemRoutes } from "./routes/system.js";
import { authRoutes } from "./routes/auth.js";
import { planRoutes } from "./routes/plans.js";
import { accountRoutes } from "./routes/accounts.js";
import { siteRoutes } from "./routes/sites.js";
import { hookRoutes } from "./routes/hooks.js";
import { envVarRoutes } from "./routes/envvars.js";
import { logRoutes } from "./routes/logs.js";
import { auditRoutes } from "./routes/audit.js";
import { cfConnectionRoutes } from "./routes/cf-connections.js";
import { databaseRoutes } from "./routes/databases.js";
import { fileRoutes } from "./routes/files.js";
import { backupRoutes } from "./routes/backups.js";
import { backupRemoteRoutes } from "./routes/backup-remotes.js";
import { gitIntegrationRoutes } from "./routes/git-integrations.js";
import { userRoutes } from "./routes/users.js";
import { invitationRoutes } from "./routes/invitations.js";
import { removalRequestRoutes } from "./routes/removal-requests.js";
import { statsRoutes } from "./routes/stats.js";
import { certificateRoutes } from "./routes/certificates.js";
import { alertRoutes } from "./routes/alerts.js";
import { DeployQueue } from "./deploy/queue.js";

export interface AppOptions {
  agentClient: AgentClient;
  skipRateLimit?: boolean;
  /** Internal log of unexpected (5xx) errors. Never shown to the browser. */
  logger?: boolean | { level: string };
}

const CLIENT_ERRORS: Record<number, { code: string; message: string }> = {
  400: { code: "INVALID_REQUEST", message: "Invalid request" },
  401: { code: "UNAUTHORIZED", message: "Authentication required" },
  403: { code: "FORBIDDEN", message: "Access denied" },
  404: { code: "NOT_FOUND", message: "Not found" },
  405: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" },
  408: { code: "REQUEST_TIMEOUT", message: "Request timed out" },
  413: { code: "PAYLOAD_TOO_LARGE", message: "Request body too large" },
  414: { code: "URI_TOO_LONG", message: "Request URL too long" },
  415: { code: "UNSUPPORTED_MEDIA_TYPE", message: "Unsupported content type" },
  429: { code: "RATE_LIMITED", message: "Too many requests" },
};

export async function buildApp(opts: AppOptions) {
  const app = Fastify({ logger: opts.logger ?? false });

  // Errors: the browser only ever gets a code and a generic message. Parser,
  // database or agent details (and stack traces) go to the internal log.
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const status =
      typeof error.statusCode === "number" && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    if (status === 500) {
      request.log.error({ err: error }, "unhandled error");
      return reply
        .status(500)
        .send({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
    }
    const body = CLIENT_ERRORS[status] ?? CLIENT_ERRORS[400];
    return reply.status(status).send({ error: body });
  });

  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({ error: CLIENT_ERRORS[404] });
  });

  // Every JSON body of the API is an object. `null`, arrays and scalars would
  // make handlers dereference undefined; a missing body becomes `{}`.
  app.addHook("preValidation", async (request, reply) => {
    if (!request.url.startsWith("/api/")) return;
    if (request.method === "GET" || request.method === "HEAD" || request.method === "OPTIONS") return;
    const body: unknown = request.body;
    if (body === undefined) {
      request.body = {};
      return;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body) || Buffer.isBuffer(body)) {
      return reply
        .status(400)
        .send({ error: { code: "INVALID_BODY", message: "Request body must be a JSON object" } });
    }
  });

  await app.register(cookie);

  if (!opts.skipRateLimit) {
    await app.register(rateLimit, {
      global: false,
    });
  }

  app.addHook("onSend", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "same-origin");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'",
    );
  });

  app.register(systemRoutes, { agentClient: opts.agentClient });
  app.register(authRoutes);
  app.register(planRoutes);
  app.register(accountRoutes, { agentClient: opts.agentClient });
  app.register(siteRoutes, { agentClient: opts.agentClient });
  app.register(envVarRoutes);
  app.register(logRoutes, { agentClient: opts.agentClient });
  app.register(auditRoutes);
  app.register(cfConnectionRoutes, { agentClient: opts.agentClient });
  app.register(databaseRoutes, { agentClient: opts.agentClient });
  app.register(fileRoutes, { agentClient: opts.agentClient });
  app.register(backupRoutes, { agentClient: opts.agentClient });
  app.register(backupRemoteRoutes, { agentClient: opts.agentClient });
  app.register(gitIntegrationRoutes);
  app.register(userRoutes);
  app.register(invitationRoutes);
  app.register(removalRequestRoutes, { agentClient: opts.agentClient });
  app.register(statsRoutes, { agentClient: opts.agentClient });
  app.register(certificateRoutes, { agentClient: opts.agentClient });
  app.register(alertRoutes);

  const deployQueue = new DeployQueue();
  app.register(hookRoutes, {
    agentClient: opts.agentClient,
    deployQueue,
  });

  return app;
}
