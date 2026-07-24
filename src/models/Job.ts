import type { JobStatus } from "../types/status.js";

export interface Job {
  id: string;
  command: string[];
  cwd: string | null;
  status: JobStatus;
  attempts: number;
  maxRetries: number;
  availableAt: string;
  workerId: string | null;
  leaseUntil: string | null;
  lastError: string | null;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface JobRow {
  id: string;
  command: string;
  cwd: string | null;
  status: JobStatus;
  attempts: number;
  max_retries: number;
  available_at: string;
  worker_id: string | null;
  lease_until: string | null;
  last_error: string | null;
  exit_code: number | null;
  stdout: string | null;
  stderr: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function mapJobRow(row: JobRow): Job {
  return {
    id: row.id,
    command: JSON.parse(row.command) as string[],
    cwd: row.cwd,
    status: row.status,
    attempts: row.attempts,
    maxRetries: row.max_retries,
    availableAt: row.available_at,
    workerId: row.worker_id,
    leaseUntil: row.lease_until,
    lastError: row.last_error,
    exitCode: row.exit_code,
    stdout: row.stdout,
    stderr: row.stderr,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
