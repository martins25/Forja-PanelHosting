import type { FastifyInstance, FastifyReply } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDB } from "../db/connection.js";
import {
  ALERT_EVENTS,
  alertChannels,
  alertLog,
  alertRules,
  users,
  type AlertEvent,
} from "../db/schema.js";
import { requireSession, requireCSRF } from "../auth/middleware.js";
import { logAudit } from "../audit/log.js";
import { isEmail } from "../validation.js";

const MAX_CHANNELS_PER_USER = 10;
const MAX_RULES_PER_USER = 50;
const MAX_ADDRESS_LENGTH = 254;
const DEFAULT_LOG_LIMIT = 100;
const MAX_LOG_LIMIT = 500;
const THRESHOLD_EVENTS: readonly AlertEvent[] = ["disk_high", "ram_high"];

function parseId(value: string): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function badRequest(reply: FastifyReply, code: string, message: string) {
  return reply.status(400).send({ error: { code, message } });
}

function notFound(reply: FastifyReply, message: string) {
  return reply.status(404).send({ error: { code: "NOT_FOUND", message } });
}

function validAddress(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_ADDRESS_LENGTH && isEmail(value);
}

function addressOf(config: string): string {
  try {
    const parsed = JSON.parse(config) as { address?: unknown };
    return typeof parsed.address === "string" ? parsed.address : "";
  } catch {
    return "";
  }
}

function thresholdOf(raw: string | null): { percent: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { percent?: unknown };
    return typeof parsed.percent === "number" ? { percent: parsed.percent } : null;
  } catch {
    return null;
  }
}

interface ChannelRow {
  id: number;
  userId: number;
  kind: "email";
  config: string;
  enabled: boolean;
}

function publicChannel(row: ChannelRow) {
  return {
    id: row.id,
    userId: row.userId,
    kind: row.kind,
    address: addressOf(row.config),
    enabled: row.enabled,
  };
}

export async function alertRoutes(app: FastifyInstance) {
  // The channel is visible to its owner and to admins. A client asking for someone
  // else's channel gets the same 404 as for a missing one.
  function findVisibleChannel(id: number, user: { id: number; role: string }) {
    const row = getDB()
      .select()
      .from(alertChannels)
      .where(eq(alertChannels.id, id))
      .get();
    if (!row) return undefined;
    if (user.role !== "admin" && row.userId !== user.id) return undefined;
    return row;
  }

  // ---- Channels ----

  app.get(
    "/api/alerts/channels",
    { preHandler: [requireSession] },
    async (request) => {
      const user = request.session!.user;
      const db = getDB();
      const rows = db
        .select()
        .from(alertChannels)
        .where(user.role === "admin" ? undefined : eq(alertChannels.userId, user.id))
        .orderBy(alertChannels.id)
        .all();
      return rows.map(publicChannel);
    },
  );

  app.post(
    "/api/alerts/channels",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      const user = request.session!.user;
      const body = (request.body ?? {}) as {
        kind?: unknown;
        address?: unknown;
        enabled?: unknown;
      };
      if (body.kind !== "email") {
        return badRequest(reply, "INVALID_KIND", "kind must be email");
      }
      if (!validAddress(body.address)) {
        return badRequest(reply, "INVALID_ADDRESS", "address must be a valid email address");
      }
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        return badRequest(reply, "INVALID_BODY", "enabled must be a boolean");
      }

      const db = getDB();
      const count = db
        .select({ id: alertChannels.id })
        .from(alertChannels)
        .where(eq(alertChannels.userId, user.id))
        .all().length;
      if (count >= MAX_CHANNELS_PER_USER) {
        return reply.status(409).send({
          error: { code: "LIMIT_REACHED", message: "Too many alert channels" },
        });
      }

      const row = db
        .insert(alertChannels)
        .values({
          userId: user.id,
          kind: "email",
          config: JSON.stringify({ address: body.address }),
          enabled: body.enabled ?? true,
        })
        .returning()
        .get();

      logAudit({
        actorUserId: user.id,
        actorKind: "user",
        action: "alert_channel.create",
        targetType: "alert_channel",
        targetId: String(row.id),
        result: "ok",
      });
      return reply.status(201).send(publicChannel(row));
    },
  );

  app.patch(
    "/api/alerts/channels/:id",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      const id = parseId((request.params as { id: string }).id);
      if (!id) return badRequest(reply, "INVALID_ID", "Invalid channel ID");
      const user = request.session!.user;

      const body = (request.body ?? {}) as {
        kind?: unknown;
        address?: unknown;
        enabled?: unknown;
      };
      if (body.kind !== undefined && body.kind !== "email") {
        return badRequest(reply, "INVALID_KIND", "kind must be email");
      }
      if (body.address !== undefined && !validAddress(body.address)) {
        return badRequest(reply, "INVALID_ADDRESS", "address must be a valid email address");
      }
      if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
        return badRequest(reply, "INVALID_BODY", "enabled must be a boolean");
      }
      if (body.address === undefined && body.enabled === undefined) {
        return badRequest(reply, "INVALID_BODY", "Nothing to update");
      }

      const existing = findVisibleChannel(id, user);
      if (!existing) return notFound(reply, "Channel not found");

      const changes: Partial<typeof alertChannels.$inferInsert> = {};
      if (body.address !== undefined) {
        changes.config = JSON.stringify({ address: body.address });
      }
      if (body.enabled !== undefined) changes.enabled = body.enabled;

      const row = getDB()
        .update(alertChannels)
        .set(changes)
        .where(eq(alertChannels.id, id))
        .returning()
        .get();

      logAudit({
        actorUserId: user.id,
        actorKind: "user",
        action: "alert_channel.update",
        targetType: "alert_channel",
        targetId: String(id),
        result: "ok",
      });
      return publicChannel(row);
    },
  );

  // Deleting a channel also removes its rules and its history.
  app.delete(
    "/api/alerts/channels/:id",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      const id = parseId((request.params as { id: string }).id);
      if (!id) return badRequest(reply, "INVALID_ID", "Invalid channel ID");
      const user = request.session!.user;

      const existing = findVisibleChannel(id, user);
      if (!existing) return notFound(reply, "Channel not found");

      const db = getDB();
      db.transaction((tx) => {
        tx.delete(alertRules).where(eq(alertRules.channelId, id)).run();
        tx.delete(alertLog).where(eq(alertLog.channelId, id)).run();
        tx.delete(alertChannels).where(eq(alertChannels.id, id)).run();
      });

      logAudit({
        actorUserId: user.id,
        actorKind: "user",
        action: "alert_channel.delete",
        targetType: "alert_channel",
        targetId: String(id),
        result: "ok",
      });
      return reply.status(204).send();
    },
  );

  // ---- Rules ----

  app.get(
    "/api/alerts/rules",
    { preHandler: [requireSession] },
    async (request) => {
      const user = request.session!.user;
      const rows = getDB()
        .select()
        .from(alertRules)
        .where(user.role === "admin" ? undefined : eq(alertRules.userId, user.id))
        .orderBy(alertRules.id)
        .all();
      return rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        event: r.event,
        channelId: r.channelId,
        threshold: thresholdOf(r.threshold),
      }));
    },
  );

  app.post(
    "/api/alerts/rules",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      const user = request.session!.user;
      const body = (request.body ?? {}) as {
        event?: unknown;
        channelId?: unknown;
        threshold?: unknown;
      };

      if (
        typeof body.event !== "string" ||
        !(ALERT_EVENTS as readonly string[]).includes(body.event)
      ) {
        return badRequest(
          reply,
          "INVALID_EVENT",
          `event must be one of: ${ALERT_EVENTS.join(", ")}`,
        );
      }
      const event = body.event as AlertEvent;

      if (
        typeof body.channelId !== "number" ||
        !Number.isInteger(body.channelId) ||
        body.channelId <= 0
      ) {
        return badRequest(reply, "INVALID_BODY", "channelId must be a positive integer");
      }

      let threshold: string | null = null;
      if (body.threshold !== undefined && body.threshold !== null) {
        const t = body.threshold as { percent?: unknown };
        if (!THRESHOLD_EVENTS.includes(event)) {
          return badRequest(reply, "INVALID_THRESHOLD", "threshold only applies to disk_high and ram_high");
        }
        if (
          typeof t !== "object" ||
          typeof t.percent !== "number" ||
          !Number.isFinite(t.percent) ||
          t.percent < 1 ||
          t.percent > 100
        ) {
          return badRequest(reply, "INVALID_THRESHOLD", "threshold.percent must be a number between 1 and 100");
        }
        threshold = JSON.stringify({ percent: t.percent });
      }

      const db = getDB();
      // Rules always use one of the caller's own channels, admin included.
      const channel = db
        .select()
        .from(alertChannels)
        .where(
          and(eq(alertChannels.id, body.channelId), eq(alertChannels.userId, user.id)),
        )
        .get();
      if (!channel) return notFound(reply, "Channel not found");

      const count = db
        .select({ id: alertRules.id })
        .from(alertRules)
        .where(eq(alertRules.userId, user.id))
        .all().length;
      if (count >= MAX_RULES_PER_USER) {
        return reply.status(409).send({
          error: { code: "LIMIT_REACHED", message: "Too many alert rules" },
        });
      }

      const duplicate = db
        .select()
        .from(alertRules)
        .where(
          and(
            eq(alertRules.userId, user.id),
            eq(alertRules.event, event),
            eq(alertRules.channelId, channel.id),
          ),
        )
        .get();
      if (duplicate) {
        return reply.status(409).send({
          error: { code: "RULE_EXISTS", message: "That rule already exists" },
        });
      }

      const row = db
        .insert(alertRules)
        .values({ userId: user.id, event, channelId: channel.id, threshold })
        .returning()
        .get();

      logAudit({
        actorUserId: user.id,
        actorKind: "user",
        action: "alert_rule.create",
        targetType: "alert_rule",
        targetId: String(row.id),
        paramsRedacted: JSON.stringify({ event, channel_id: channel.id }),
        result: "ok",
      });
      return reply.status(201).send({
        id: row.id,
        userId: row.userId,
        event: row.event,
        channelId: row.channelId,
        threshold: thresholdOf(row.threshold),
      });
    },
  );

  app.delete(
    "/api/alerts/rules/:id",
    { preHandler: [requireSession, requireCSRF] },
    async (request, reply) => {
      const id = parseId((request.params as { id: string }).id);
      if (!id) return badRequest(reply, "INVALID_ID", "Invalid rule ID");
      const user = request.session!.user;

      const db = getDB();
      const rule = db.select().from(alertRules).where(eq(alertRules.id, id)).get();
      if (!rule || (user.role !== "admin" && rule.userId !== user.id)) {
        return notFound(reply, "Rule not found");
      }

      db.delete(alertRules).where(eq(alertRules.id, id)).run();
      logAudit({
        actorUserId: user.id,
        actorKind: "user",
        action: "alert_rule.delete",
        targetType: "alert_rule",
        targetId: String(id),
        result: "ok",
      });
      return reply.status(204).send();
    },
  );

  // ---- History ----

  app.get(
    "/api/alerts/log",
    { preHandler: [requireSession] },
    async (request, reply) => {
      const { limit } = request.query as { limit?: string };
      let max = DEFAULT_LOG_LIMIT;
      if (limit !== undefined) {
        const n = Number(limit);
        if (!Number.isInteger(n) || n < 1 || n > MAX_LOG_LIMIT) {
          return badRequest(
            reply,
            "INVALID_QUERY",
            `limit must be an integer between 1 and ${MAX_LOG_LIMIT}`,
          );
        }
        max = n;
      }

      const user = request.session!.user;
      const db = getDB();
      const conditions = [];
      if (user.role !== "admin") {
        const own = db
          .select({ id: alertChannels.id })
          .from(alertChannels)
          .where(eq(alertChannels.userId, user.id))
          .all()
          .map((c) => c.id);
        if (own.length === 0) return [];
        conditions.push(inArray(alertLog.channelId, own));
      }

      return db
        .select({
          id: alertLog.id,
          channelId: alertLog.channelId,
          ownerEmail: users.email,
          event: alertLog.event,
          message: alertLog.message,
          sentAt: alertLog.sentAt,
          status: alertLog.status,
        })
        .from(alertLog)
        .innerJoin(alertChannels, eq(alertLog.channelId, alertChannels.id))
        .innerJoin(users, eq(alertChannels.userId, users.id))
        .where(conditions.length ? and(...conditions) : undefined)
        .orderBy(desc(alertLog.id))
        .limit(max)
        .all();
    },
  );
}
