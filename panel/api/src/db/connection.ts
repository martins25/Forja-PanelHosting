import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate as drizzleMigrate } from "drizzle-orm/better-sqlite3/migrator";
import Database from "better-sqlite3";
import * as schema from "./schema.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDB(url?: string) {
  if (!db) {
    const dbPath = url ?? process.env.DATABASE_URL ?? "/var/lib/forja/panel.db";
    const sqlite = new Database(dbPath);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    db = drizzle(sqlite, { schema });
  }
  return db;
}

export function migrate(database?: ReturnType<typeof drizzle<typeof schema>>) {
  const d = database ?? getDB();
  drizzleMigrate(d, {
    migrationsFolder: path.join(__dirname, "migrations"),
  });
}

export function resetDB() {
  db = null;
}
