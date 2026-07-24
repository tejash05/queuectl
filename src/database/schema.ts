export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workers (
  id TEXT PRIMARY KEY,
  hostname TEXT NOT NULL,
  pid INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'stopping', 'stopped')),
  last_heartbeat_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  stopped_at TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  command TEXT NOT NULL,
  cwd TEXT,
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'scheduled', 'running', 'completed', 'failed', 'dead')
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

CREATE TABLE IF NOT EXISTS job_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jobs_status_available_at
  ON jobs (status, available_at);

CREATE INDEX IF NOT EXISTS idx_jobs_worker_id
  ON jobs (worker_id);

CREATE INDEX IF NOT EXISTS idx_jobs_lease_until
  ON jobs (lease_until);

CREATE INDEX IF NOT EXISTS idx_job_history_job_id
  ON job_history (job_id);

CREATE INDEX IF NOT EXISTS idx_workers_status
  ON workers (status);
`;
