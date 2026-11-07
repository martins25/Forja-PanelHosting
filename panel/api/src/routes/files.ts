import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import type { AgentClient } from "../agent/client.js";
import { getDB } from "../db/connection.js";
import { accounts } from "../db/schema.js";
import {
  requireSession,
  requireCSRF,
  requireAccountAccess,
} from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";
import { accountPath } from "../validation.js";

interface FilesOpts {
  agentClient: AgentClient;
}

function parseId(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function invalidPath(reply: FastifyReply) {
  return reply
    .status(400)
    .send({ error: { code: "INVALID_PATH", message: "Invalid path" } });
}

function getAccountSlug(accountId: number): string | null {
  const db = getDB();
  const account = db
    .select()
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .get();
  return account?.slug ?? null;
}

export async function fileRoutes(app: FastifyInstance, opts: FilesOpts) {
  const agent = opts.agentClient;

  // List directory
  app.get(
    "/api/accounts/:accountId/files",
    { preHandler: [requireSession, requireAccountAccess("accountId")] },
    async (request, reply) => {
      const accountId = parseId(
        (request.params as { accountId: string }).accountId,
      );
      if (!accountId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid account ID" } });
      }

      const slug = getAccountSlug(accountId);
      if (!slug) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Account not found" } });
      }

      const rawPath = (request.query as { path?: unknown }).path;
      const path = rawPath === undefined || rawPath === "" ? "." : accountPath(rawPath);
      if (!path) return invalidPath(reply);

      const res = await agent.callAction("files.list", {
        account_slug: slug,
        path,
      });

      if (!res.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "files.list",
          targetType: "account",
          targetId: String(accountId),
          paramsRedacted: JSON.stringify({ path }),
          result: "error",
          errorCode: res.error?.code ?? "AGENT_ERROR",
        });
        return reply.status(502).send({
          error: {
            code: res.error?.code ?? "AGENT_ERROR",
            message: "File operation failed",
          },
        });
      }

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "files.list",
        targetType: "account",
        targetId: String(accountId),
        paramsRedacted: JSON.stringify({ path }),
        result: "ok",
      });

      return res.result;
    },
  );

  // Read file
  app.get(
    "/api/accounts/:accountId/files/content",
    { preHandler: [requireSession, requireAccountAccess("accountId")] },
    async (request, reply) => {
      const accountId = parseId(
        (request.params as { accountId: string }).accountId,
      );
      if (!accountId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid account ID" } });
      }

      const slug = getAccountSlug(accountId);
      if (!slug) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Account not found" } });
      }

      const path = accountPath((request.query as { path?: unknown }).path);
      if (!path) return invalidPath(reply);

      const res = await agent.callAction("files.read", {
        account_slug: slug,
        path,
      });

      if (!res.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "files.read",
          targetType: "account",
          targetId: String(accountId),
          paramsRedacted: JSON.stringify({ path }),
          result: "error",
          errorCode: res.error?.code ?? "AGENT_ERROR",
        });
        return reply.status(502).send({
          error: {
            code: res.error?.code ?? "AGENT_ERROR",
            message: "File operation failed",
          },
        });
      }

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "files.read",
        targetType: "account",
        targetId: String(accountId),
        paramsRedacted: JSON.stringify({ path }),
        result: "ok",
      });

      return res.result;
    },
  );

  // Write file
  app.put(
    "/api/accounts/:accountId/files/content",
    {
      preHandler: [requireSession, requireCSRF, requireAccountAccess("accountId")],
      bodyLimit: 6 * 1024 * 1024,
    },
    async (request, reply) => {
      const accountId = parseId(
        (request.params as { accountId: string }).accountId,
      );
      if (!accountId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid account ID" } });
      }

      const slug = getAccountSlug(accountId);
      if (!slug) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Account not found" } });
      }

      const body = (request.body ?? {}) as { path?: unknown; content?: unknown };
      const path = accountPath(body.path);
      if (!path) return invalidPath(reply);
      if (typeof body.content !== "string") {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_BODY", message: "path and content are required" } });
      }

      const res = await agent.callAction("files.write", {
        account_slug: slug,
        path,
        content: body.content,
      });

      if (!res.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "files.write",
          targetType: "account",
          targetId: String(accountId),
          paramsRedacted: JSON.stringify({ path }),
          result: "error",
          errorCode: res.error?.code ?? "AGENT_ERROR",
        });
        return reply.status(502).send({
          error: {
            code: res.error?.code ?? "AGENT_ERROR",
            message: "File operation failed",
          },
        });
      }

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "files.write",
        targetType: "account",
        targetId: String(accountId),
        paramsRedacted: JSON.stringify({ path }),
        result: "ok",
      });

      return res.result;
    },
  );

  // Delete file/dir
  app.delete(
    "/api/accounts/:accountId/files",
    { preHandler: [requireSession, requireCSRF, requireAccountAccess("accountId")] },
    async (request, reply) => {
      const accountId = parseId(
        (request.params as { accountId: string }).accountId,
      );
      if (!accountId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid account ID" } });
      }

      const slug = getAccountSlug(accountId);
      if (!slug) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Account not found" } });
      }

      const query = request.query as { path?: unknown; recursive?: unknown };
      const path = accountPath(query.path);
      if (!path) return invalidPath(reply);

      const res = await agent.callAction("files.delete", {
        account_slug: slug,
        path,
        recursive: query.recursive === "true",
      });

      if (!res.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "files.delete",
          targetType: "account",
          targetId: String(accountId),
          paramsRedacted: JSON.stringify({ path }),
          result: "error",
          errorCode: res.error?.code ?? "AGENT_ERROR",
        });
        return reply.status(502).send({
          error: {
            code: res.error?.code ?? "AGENT_ERROR",
            message: "File operation failed",
          },
        });
      }

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "files.delete",
        targetType: "account",
        targetId: String(accountId),
        paramsRedacted: JSON.stringify({ path }),
        result: "ok",
      });

      return reply.status(204).send();
    },
  );

  // Create directory
  app.post(
    "/api/accounts/:accountId/files/mkdir",
    { preHandler: [requireSession, requireCSRF, requireAccountAccess("accountId")] },
    async (request, reply) => {
      const accountId = parseId(
        (request.params as { accountId: string }).accountId,
      );
      if (!accountId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid account ID" } });
      }

      const slug = getAccountSlug(accountId);
      if (!slug) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Account not found" } });
      }

      const body = (request.body ?? {}) as { path?: unknown };
      const path = accountPath(body.path);
      if (!path) return invalidPath(reply);

      const res = await agent.callAction("files.mkdir", {
        account_slug: slug,
        path,
      });

      if (!res.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "files.mkdir",
          targetType: "account",
          targetId: String(accountId),
          paramsRedacted: JSON.stringify({ path }),
          result: "error",
          errorCode: res.error?.code ?? "AGENT_ERROR",
        });
        return reply.status(502).send({
          error: {
            code: res.error?.code ?? "AGENT_ERROR",
            message: "File operation failed",
          },
        });
      }

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "files.mkdir",
        targetType: "account",
        targetId: String(accountId),
        paramsRedacted: JSON.stringify({ path }),
        result: "ok",
      });

      return reply.status(201).send(res.result);
    },
  );

  // Upload file (base64)
  app.post(
    "/api/accounts/:accountId/files/upload",
    {
      preHandler: [requireSession, requireCSRF, requireAccountAccess("accountId")],
      bodyLimit: 15 * 1024 * 1024,
    },
    async (request, reply) => {
      const accountId = parseId(
        (request.params as { accountId: string }).accountId,
      );
      if (!accountId) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_ID", message: "Invalid account ID" } });
      }

      const slug = getAccountSlug(accountId);
      if (!slug) {
        return reply
          .status(404)
          .send({ error: { code: "NOT_FOUND", message: "Account not found" } });
      }

      const body = (request.body ?? {}) as { path?: unknown; content_base64?: unknown };
      const path = accountPath(body.path);
      if (!path) return invalidPath(reply);
      if (typeof body.content_base64 !== "string" || !body.content_base64) {
        return reply
          .status(400)
          .send({ error: { code: "INVALID_BODY", message: "path and content_base64 are required" } });
      }

      const res = await agent.callAction("files.upload", {
        account_slug: slug,
        path,
        content_base64: body.content_base64,
      });

      if (!res.ok) {
        logAudit({
          actorUserId: request.session!.user.id,
          actorKind: "user",
          action: "files.upload",
          targetType: "account",
          targetId: String(accountId),
          paramsRedacted: JSON.stringify({ path }),
          result: "error",
          errorCode: res.error?.code ?? "AGENT_ERROR",
        });
        return reply.status(502).send({
          error: {
            code: res.error?.code ?? "AGENT_ERROR",
            message: "File operation failed",
          },
        });
      }

      logAudit({
        actorUserId: request.session!.user.id,
        actorKind: "user",
        action: "files.upload",
        targetType: "account",
        targetId: String(accountId),
        paramsRedacted: JSON.stringify({ path }),
        result: "ok",
      });

      return reply.status(201).send(res.result);
    },
  );
}
