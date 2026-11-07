import { getDB } from "../db/connection.js";
import { auditLog } from "../db/schema.js";

export interface AuditEntry {
  actorUserId: number;
  actorKind: "user" | "system" | "webhook";
  action: string;
  targetType?: string;
  targetId?: string;
  paramsRedacted?: string;
  result: "ok" | "error";
  errorCode?: string;
}

export function logAudit(entry: AuditEntry): void {
  const db = getDB();
  db.insert(auditLog)
    .values({
      actorUserId: entry.actorUserId,
      actorKind: entry.actorKind,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      paramsRedacted: entry.paramsRedacted ?? null,
      result: entry.result,
      errorCode: entry.errorCode ?? null,
    })
    .run();
}
