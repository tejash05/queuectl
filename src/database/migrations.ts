import type Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { DEFAULT_CONFIG } from "../utils/constants.js";
import { nowIso } from "../utils/time.js";

interface Migration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  {
    id: 1,
    name: "001_initial_schema",
    up(db) {
      db.exec(SCHEMA_SQL);

      const insert = db.prepare(
        `INSERT OR IGNORE INTO config (key, value, updated_at) VALUES (?, ?, ?)`,
      );
      const ts = nowIso();
      for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
        insert.run(key, String(value), ts);
      }
    },
  },
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db
      .prepare(`SELECT id FROM schema_migrations`)
      .all()
      .map((row) => (row as { id: number }).id),
  );

  const markApplied = db.prepare(
    `INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)`,
  );

  const applyAll = db.transaction(() => {
    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      migration.up(db);
      markApplied.run(migration.id, migration.name, nowIso());
    }
  });

  applyAll();
}
