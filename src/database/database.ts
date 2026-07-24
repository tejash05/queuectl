import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { DEFAULT_DB_FILENAME } from "../utils/constants.js";
import { runMigrations } from "./migrations.js";
import { logger } from "../utils/logger.js";

export type SqliteDatabase = Database.Database;

export function resolveDbPath(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.QUEUECTL_DB) return path.resolve(process.env.QUEUECTL_DB);
  return path.resolve(process.cwd(), "data", DEFAULT_DB_FILENAME);
}

export function openDatabase(dbPath = resolveDbPath()): SqliteDatabase {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  db.pragma("synchronous = NORMAL");

  runMigrations(db);
  logger.debug("Database opened", { path: dbPath });
  return db;
}

export function closeDatabase(db: SqliteDatabase): void {
  db.close();
}
