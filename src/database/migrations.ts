import type Database from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { DEFAULT_CONFIG } from "../utils/constants.js";
import { nowIso } from "../utils/time.js";

interface Migration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
}

const LEGACY_CONFIG_KEY_MAP: Record<string, string> = {
  max_retries: "max-retries",
  backoff_base_ms: "backoff-base",
  lease_timeout_ms: "lease-timeout-ms",
  heartbeat_interval_ms: "heartbeat-interval-ms",
  poll_interval_ms: "poll-interval-ms",
  output_truncate_bytes: "output-truncate-bytes",
  shutdown_grace_ms: "shutdown-grace-ms",
};

function seedConfig(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO config (key, value, updated_at) VALUES (?, ?, ?)`,
  );
  const ts = nowIso();
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    insert.run(key, String(value), ts);
  }
}

function migrateConfigKeys(db: Database.Database): void {
  const rows = db.prepare(`SELECT key, value, updated_at FROM config`).all() as Array<{
    key: string;
    value: string;
    updated_at: string;
  }>;

  const upsert = db.prepare(
    `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const del = db.prepare(`DELETE FROM config WHERE key = ?`);

  for (const row of rows) {
    const mapped = LEGACY_CONFIG_KEY_MAP[row.key];
    if (!mapped) continue;

    let value = row.value;
    // Old backoff was milliseconds with different formula; assignment default is 2.
    if (row.key === "backoff_base_ms") {
      value = String(DEFAULT_CONFIG["backoff-base"]);
    }
    upsert.run(mapped, value, row.updated_at);
    del.run(row.key);
  }

  seedConfig(db);
}

function tableHasColumn(db: Database.Database, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table) as { name: string } | undefined;
  return Boolean(row);
}

const migrations: Migration[] = [
  {
    id: 1,
    name: "001_initial_schema",
    up(db) {
      db.exec(SCHEMA_SQL);
      seedConfig(db);
    },
  },
  {
    id: 2,
    name: "002_assignment_contract",
    up(db) {
      migrateConfigKeys(db);

      if (!tableExists(db, "jobs")) {
        db.exec(SCHEMA_SQL);
        seedConfig(db);
        return;
      }

      // Already on assignment schema
      if (tableHasColumn(db, "jobs", "state")) {
        return;
      }

      db.exec(`
        CREATE TABLE jobs_new (
          id TEXT PRIMARY KEY,
          command TEXT NOT NULL,
          cwd TEXT,
          state TEXT NOT NULL CHECK (
            state IN ('pending', 'processing', 'completed', 'failed', 'dead')
          ),
          attempts INTEGER NOT NULL DEFAULT 0,
          max_retries INTEGER NOT NULL,
          available_at TEXT NOT NULL,
          worker_id TEXT REFERENCES workers(id),
          lease_until TEXT,
          last_error TEXT,
          exit_code INTEGER,
          stdout TEXT,
          stderr TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          started_at TEXT,
          finished_at TEXT
        );
      `);

      const oldRows = db.prepare(`SELECT * FROM jobs`).all() as Array<Record<string, unknown>>;
      const insert = db.prepare(`
        INSERT INTO jobs_new (
          id, command, cwd, state, attempts, max_retries, available_at,
          worker_id, lease_until, last_error, exit_code, stdout, stderr,
          created_at, updated_at, started_at, finished_at
        ) VALUES (
          @id, @command, @cwd, @state, @attempts, @max_retries, @available_at,
          @worker_id, @lease_until, @last_error, @exit_code, @stdout, @stderr,
          @created_at, @updated_at, @started_at, @finished_at
        )
      `);

      const mapState = (status: string): string => {
        if (status === "running") return "processing";
        if (status === "scheduled") return "pending";
        return status;
      };

      const normalizeCommand = (raw: unknown): string => {
        const text = String(raw ?? "");
        if (text.trim().startsWith("[")) {
          try {
            const parsed = JSON.parse(text) as unknown;
            if (Array.isArray(parsed) && parsed.every((p) => typeof p === "string")) {
              return parsed.join(" ");
            }
          } catch {
            // keep raw
          }
        }
        return text;
      };

      const copy = db.transaction(() => {
        for (const row of oldRows) {
          insert.run({
            id: row.id,
            command: normalizeCommand(row.command),
            cwd: row.cwd ?? null,
            state: mapState(String(row.status)),
            attempts: row.attempts,
            max_retries: row.max_retries,
            available_at: row.available_at,
            worker_id: row.worker_id ?? null,
            lease_until: row.lease_until ?? null,
            last_error: row.last_error ?? null,
            exit_code: row.exit_code ?? null,
            stdout: row.stdout ?? null,
            stderr: row.stderr ?? null,
            created_at: row.created_at,
            updated_at: row.updated_at,
            started_at: row.started_at ?? null,
            finished_at: row.finished_at ?? null,
          });
        }
      });
      copy();

      db.exec(`PRAGMA foreign_keys = OFF`);
      db.exec(`
        DROP TABLE jobs;
        ALTER TABLE jobs_new RENAME TO jobs;
        CREATE INDEX IF NOT EXISTS idx_jobs_state_available_at ON jobs (state, available_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_worker_id ON jobs (worker_id);
        CREATE INDEX IF NOT EXISTS idx_jobs_lease_until ON jobs (lease_until);
      `);
      db.exec(`PRAGMA foreign_keys = ON`);
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
