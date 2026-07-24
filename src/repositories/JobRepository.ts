import type { SqliteDatabase } from "../database/database.js";
import { mapJobRow, type Job, type JobRow } from "../models/Job.js";
import type { JobEvent } from "../types/events.js";
import type { JobStatus } from "../types/status.js";
import { createId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

export interface CreateJobInput {
  command: string[];
  cwd?: string | null;
  maxRetries: number;
}

export interface ClaimJobInput {
  workerId: string;
  leaseUntil: string;
  now: string;
}

export interface CompleteJobInput {
  jobId: string;
  exitCode: number;
  stdout: string | null;
  stderr: string | null;
}

export interface FailJobInput {
  jobId: string;
  error: string;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
}

export interface ScheduleRetryInput {
  jobId: string;
  availableAt: string;
  error: string;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
}

export class JobRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(input: CreateJobInput): Job {
    const id = createId();
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs (
          id, command, cwd, status, attempts, max_retries, available_at,
          worker_id, lease_until, last_error, exit_code, stdout, stderr,
          created_at, updated_at, started_at, finished_at
        ) VALUES (?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
      )
      .run(id, JSON.stringify(input.command), input.cwd ?? null, input.maxRetries, ts, ts, ts);

    this.appendHistory(id, "enqueued", `command=${JSON.stringify(input.command)}`);
    return this.getById(id)!;
  }

  getById(id: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
    return row ? mapJobRow(row) : null;
  }

  list(options: { status?: JobStatus; limit: number }): Job[] {
    if (options.status) {
      const rows = this.db
        .prepare(`SELECT * FROM jobs WHERE status = ? ORDER BY created_at DESC LIMIT ?`)
        .all(options.status, options.limit) as JobRow[];
      return rows.map(mapJobRow);
    }

    const rows = this.db
      .prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`)
      .all(options.limit) as JobRow[];
    return rows.map(mapJobRow);
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM jobs GROUP BY status`)
      .all() as Array<{ status: string; count: number }>;

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }

  /**
   * Atomically claim the oldest available pending/scheduled job.
   * Uses BEGIN IMMEDIATE so concurrent writers serialize on the write lock.
   */
  claimNext(input: ClaimJobInput): Job | null {
    const run = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'running',
               worker_id = ?,
               lease_until = ?,
               started_at = ?,
               updated_at = ?,
               attempts = attempts + 1,
               last_error = NULL,
               exit_code = NULL,
               stdout = NULL,
               stderr = NULL,
               finished_at = NULL
           WHERE id = (
             SELECT id FROM jobs
             WHERE status IN ('pending', 'scheduled')
               AND available_at <= ?
             ORDER BY created_at ASC
             LIMIT 1
           )
           RETURNING *`,
        )
        .get(input.workerId, input.leaseUntil, input.now, input.now, input.now) as
        | JobRow
        | undefined;

      if (row) {
        this.appendHistory(row.id, "claimed", `worker_id=${input.workerId}`);
        return mapJobRow(row);
      }
      return null;
    });

    return run.immediate();
  }

  markCompleted(input: CompleteJobInput): Job {
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'completed',
             exit_code = ?,
             stdout = ?,
             stderr = ?,
             lease_until = NULL,
             updated_at = ?,
             finished_at = ?
         WHERE id = ?`,
      )
      .run(input.exitCode, input.stdout, input.stderr, ts, ts, input.jobId);

    this.appendHistory(input.jobId, "completed", `exit_code=${input.exitCode}`);
    return this.getById(input.jobId)!;
  }

  markFailedTerminal(input: FailJobInput): Job {
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             last_error = ?,
             exit_code = ?,
             stdout = ?,
             stderr = ?,
             lease_until = NULL,
             updated_at = ?,
             finished_at = ?
         WHERE id = ?`,
      )
      .run(
        input.error,
        input.exitCode,
        input.stdout,
        input.stderr,
        ts,
        ts,
        input.jobId,
      );

    this.appendHistory(input.jobId, "failed", input.error);
    return this.getById(input.jobId)!;
  }

  markDead(input: FailJobInput): Job {
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'dead',
             last_error = ?,
             exit_code = ?,
             stdout = ?,
             stderr = ?,
             lease_until = NULL,
             worker_id = worker_id,
             updated_at = ?,
             finished_at = ?
         WHERE id = ?`,
      )
      .run(
        input.error,
        input.exitCode,
        input.stdout,
        input.stderr,
        ts,
        ts,
        input.jobId,
      );

    this.appendHistory(input.jobId, "dead", input.error);
    return this.getById(input.jobId)!;
  }

  scheduleRetry(input: ScheduleRetryInput): Job {
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'scheduled',
             available_at = ?,
             last_error = ?,
             exit_code = ?,
             stdout = ?,
             stderr = ?,
             worker_id = NULL,
             lease_until = NULL,
             started_at = NULL,
             finished_at = NULL,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(
        input.availableAt,
        input.error,
        input.exitCode,
        input.stdout,
        input.stderr,
        ts,
        input.jobId,
      );

    this.appendHistory(
      input.jobId,
      "retry_scheduled",
      `available_at=${input.availableAt}; error=${input.error}`,
    );
    return this.getById(input.jobId)!;
  }

  extendLease(jobId: string, leaseUntil: string): void {
    this.db
      .prepare(`UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
      .run(leaseUntil, nowIso(), jobId);
  }

  recoverExpiredLeases(now: string): Job[] {
    const recover = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `UPDATE jobs
           SET status = 'pending',
               worker_id = NULL,
               lease_until = NULL,
               started_at = NULL,
               updated_at = ?,
               available_at = ?
           WHERE status = 'running'
             AND lease_until IS NOT NULL
             AND lease_until < ?
           RETURNING *`,
        )
        .all(now, now, now) as JobRow[];

      for (const row of rows) {
        this.appendHistory(row.id, "recovered", `expired_lease_before=${now}`);
      }
      return rows.map(mapJobRow);
    });

    return recover();
  }

  listDead(limit: number): Job[] {
    return this.list({ status: "dead", limit });
  }

  requeueDead(jobId: string): Job | null {
    const job = this.getById(jobId);
    if (!job || job.status !== "dead") {
      return null;
    }

    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE jobs
         SET status = 'pending',
             attempts = 0,
             available_at = ?,
             worker_id = NULL,
             lease_until = NULL,
             last_error = NULL,
             exit_code = NULL,
             stdout = NULL,
             stderr = NULL,
             started_at = NULL,
             finished_at = NULL,
             updated_at = ?
         WHERE id = ? AND status = 'dead'`,
      )
      .run(ts, ts, jobId);

    this.appendHistory(jobId, "requeued", "from=dead");
    return this.getById(jobId);
  }

  requeueAllDead(): number {
    const dead = this.listDead(10_000);
    let count = 0;
    const tx = this.db.transaction(() => {
      for (const job of dead) {
        if (this.requeueDead(job.id)) count += 1;
      }
    });
    tx();
    return count;
  }

  appendHistory(jobId: string, event: JobEvent, detail?: string): void {
    this.db
      .prepare(`INSERT INTO job_history (job_id, event, detail, created_at) VALUES (?, ?, ?, ?)`)
      .run(jobId, event, detail ?? null, nowIso());
  }
}
