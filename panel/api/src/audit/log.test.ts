import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";
import { logAudit } from "./log.js";

let sqlite: InstanceType<typeof Database>;

describe("logAudit", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });
    vi.mocked(getDB).mockReturnValue(db);
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  it("inserts an audit entry with all fields", () => {
    logAudit({
      actorUserId: 1,
      actorKind: "user",
      action: "plan.create",
      targetType: "plan",
      targetId: "42",
      result: "ok",
    });

    const rows = db.select().from(schema.auditLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(1);
    expect(rows[0].actorKind).toBe("user");
    expect(rows[0].action).toBe("plan.create");
    expect(rows[0].targetType).toBe("plan");
    expect(rows[0].targetId).toBe("42");
    expect(rows[0].result).toBe("ok");
    expect(rows[0].errorCode).toBeNull();
  });

  it("inserts an error entry", () => {
    logAudit({
      actorUserId: 1,
      actorKind: "user",
      action: "account.create",
      targetType: "account",
      result: "error",
      errorCode: "AGENT_ERROR",
    });

    const rows = db.select().from(schema.auditLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].result).toBe("error");
    expect(rows[0].errorCode).toBe("AGENT_ERROR");
  });

  it("handles missing optional fields", () => {
    logAudit({
      actorUserId: 1,
      actorKind: "system",
      action: "cleanup",
      result: "ok",
    });

    const rows = db.select().from(schema.auditLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].targetType).toBeNull();
    expect(rows[0].targetId).toBeNull();
  });
});
