import { and, eq } from "drizzle-orm";
import { getDB } from "../db/connection.js";
import {
  alertChannels,
  alertLog,
  alertRules,
  userAccounts,
  users,
  type AlertEvent,
} from "../db/schema.js";

export const DEFAULT_THRESHOLD_PERCENT = 90;

export interface AlertContext {
  // Account the event belongs to. Client rules only match events of their own accounts.
  // Events without an account (host-level disk/RAM) reach admin rules only.
  accountId?: number;
  // Human readable text. Callers must never put secrets, tokens or raw agent output in it.
  message: string;
  // Measured value (percent) for threshold events (disk_high, ram_high).
  value?: number;
}

export interface FireResult {
  queued: number;
}

export function parseThresholdPercent(raw: string | null): number {
  if (!raw) return DEFAULT_THRESHOLD_PERCENT;
  try {
    const parsed = JSON.parse(raw) as { percent?: unknown };
    if (
      typeof parsed.percent === "number" &&
      parsed.percent > 0 &&
      parsed.percent <= 100
    ) {
      return parsed.percent;
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_THRESHOLD_PERCENT;
}

// Finds the rules matching the event and queues one alert_log row per distinct channel.
// The email adapter only records the alert as "queued"; real delivery (sendmail/SMTP)
// is phase 4. This function never throws: an alert problem must not break the caller.
export function fireAlert(event: AlertEvent, context: AlertContext): FireResult {
  try {
    const db = getDB();
    const rules = db
      .select({
        channelId: alertRules.channelId,
        threshold: alertRules.threshold,
        userId: alertRules.userId,
        role: users.role,
        disabledUser: users.disabled,
        channelKind: alertChannels.kind,
        channelEnabled: alertChannels.enabled,
        channelOwner: alertChannels.userId,
      })
      .from(alertRules)
      .innerJoin(alertChannels, eq(alertRules.channelId, alertChannels.id))
      .innerJoin(users, eq(alertRules.userId, users.id))
      .where(eq(alertRules.event, event))
      .all();

    const channelIds = new Set<number>();
    for (const rule of rules) {
      if (rule.disabledUser || !rule.channelEnabled) continue;
      // A rule may only use a channel of its own user.
      if (rule.channelOwner !== rule.userId) continue;
      if (rule.channelKind !== "email") continue;

      if (rule.role !== "admin") {
        if (context.accountId === undefined) continue;
        const link = db
          .select()
          .from(userAccounts)
          .where(
            and(
              eq(userAccounts.userId, rule.userId),
              eq(userAccounts.accountId, context.accountId),
            ),
          )
          .get();
        if (!link) continue;
      }

      if (event === "disk_high" || event === "ram_high") {
        if (context.value === undefined) continue;
        if (context.value < parseThresholdPercent(rule.threshold)) continue;
      }

      channelIds.add(rule.channelId);
    }

    const sentAt = new Date().toISOString();
    for (const channelId of channelIds) {
      db.insert(alertLog)
        .values({ channelId, event, message: context.message, sentAt, status: "queued" })
        .run();
    }
    return { queued: channelIds.size };
  } catch {
    // Deliberately silent: never log context or config here (rule 7).
    return { queued: 0 };
  }
}
