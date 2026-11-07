import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "../db/schema.js";
import { hashPassword } from "./crypto.js";
import { setAppKeyForTest, clearAppKey } from "./crypto.js";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.join(__dirname, "../db/migrations");

vi.mock("../db/connection.js", () => ({
  getDB: vi.fn(),
}));

import { getDB } from "../db/connection.js";
import {
  createSession,
  getSession,
  deleteSession,
  deleteUserSessions,
  buildSessionCookie,
  buildClearCookie,
} from "./session.js";

let sqlite: InstanceType<typeof Database>;

describe("session", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeEach(async () => {
    setAppKeyForTest(randomBytes(32));
    sqlite = new Database(":memory:");
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder });

    vi.mocked(getDB).mockReturnValue(db);

    const hash = await hashPassword("test123");
    db.insert(schema.users)
      .values({
        email: "admin@forja.dev",
        role: "admin",
        passwordHash: hash,
        createdAt: new Date().toISOString(),
      })
      .run();
  });

  afterEach(() => {
    sqlite.close();
    clearAppKey();
    vi.restoreAllMocks();
  });

  describe("createSession / getSession", () => {
    it("creates a session and retrieves it", async () => {
      const { sessionId, csrfToken } = await createSession(
        1,
        "127.0.0.1",
        "TestAgent/1.0",
      );
      expect(sessionId).toBeTruthy();
      expect(csrfToken).toHaveLength(64);

      const session = await getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.user.email).toBe("admin@forja.dev");
      expect(session!.user.role).toBe("admin");
      expect(session!.csrfToken).toBe(csrfToken);
    });

    it("returns null for non-existent session", async () => {
      const session = await getSession("nonexistent-id");
      expect(session).toBeNull();
    });

    it("returns null for expired session", async () => {
      const { sessionId } = await createSession(1, "127.0.0.1", "TestAgent");

      db.update(schema.sessions)
        .set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
        .run();

      const session = await getSession(sessionId);
      expect(session).toBeNull();
    });

    it("returns null for disabled user", async () => {
      db.update(schema.users).set({ disabled: true }).run();

      const { sessionId } = await createSession(1, "127.0.0.1", "TestAgent");
      const session = await getSession(sessionId);
      expect(session).toBeNull();
    });
  });

  describe("deleteSession", () => {
    it("removes the session", async () => {
      const { sessionId } = await createSession(1, "127.0.0.1", "TestAgent");
      await deleteSession(sessionId);
      const session = await getSession(sessionId);
      expect(session).toBeNull();
    });
  });

  describe("deleteUserSessions", () => {
    it("removes all sessions for a user", async () => {
      await createSession(1, "127.0.0.1", "Agent1");
      await createSession(1, "127.0.0.1", "Agent2");
      await deleteUserSessions(1);

      const rows = db.select().from(schema.sessions).all();
      expect(rows).toHaveLength(0);
    });
  });

  describe("cookie helpers", () => {
    it("builds a session cookie with all flags", () => {
      const cookie = buildSessionCookie("abc-123", true);
      expect(cookie).toContain("forja_session=abc-123");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Path=/");
    });

    it("omits Secure when not secure", () => {
      const cookie = buildSessionCookie("abc-123", false);
      expect(cookie).not.toContain("Secure");
    });

    it("builds a clear cookie", () => {
      const cookie = buildClearCookie();
      expect(cookie).toContain("forja_session=");
      expect(cookie).toContain("Max-Age=0");
    });
  });
});
