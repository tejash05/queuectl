import type { SqliteDatabase } from "../database/database.js";
import { mapJobRow, type Job, type JobRow } from "../models/Job.js";
import type { JobEvent } from "../types/events.js";
import type { JobState } from "../types/status.js";
import { nowIso } from "../utils/time.js";

export interface CreateJobInput {
  id: string;
  command: string;
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

/** Snapshot of a job reclaimed after lease expiry (pre-reset ownership). */
export interface RecoveredLease {
  jobId: string;
  previousWorkerId: string | null;
  previousLeaseUntil: string | null;
  recoveredAt: string;
}

export class JobRepository {
  constructor(private readonly db: SqliteDatabase) {}

  create(input: CreateJobInput): Job {
    const existing = this.getById(input.id);
    if (existing) {
      throw new Error(`Job already exists: ${input.id}`);
    }

    const ts = nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs (
          id, command, cwd, state, attempts, max_retries, available_at,
          worker_id, lease_until, last_error, exit_code, stdout, stderr,
          created_at, updated_at, started_at, finished_at
        ) VALUES (?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL)`,
      )
      .run(input.id, input.command, input.cwd ?? null, input.maxRetries, ts, ts, ts);

    this.appendHistory(input.id, "enqueued", `command=${input.command}`);
    return this.getById(input.id)!;
  }

  getById(id: string): Job | null {
    const row = this.db.prepare(`SELECT * FROM jobs WHERE id = ?`).get(id) as JobRow | undefined;
    return row ? mapJobRow(row) : null;
  }

  list(options: { state?: JobState; limit: number }): Job[] {
    if (options.state) {
      const rows = this.db
        .prepare(`SELECT * FROM jobs WHERE state = ? ORDER BY created_at DESC LIMIT ?`)
        .all(options.state, options.limit) as JobRow[];
      return rows.map(mapJobRow);
    }

    const rows = this.db
      .prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`)
      .all(options.limit) as JobRow[];
    return rows.map(mapJobRow);
  }

  countByState(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT state, COUNT(*) AS count FROM jobs GROUP BY state`)
      .all() as Array<{ state: string; count: number }>;

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.state] = row.count;
    }
    return counts;
  }

  /**
   * Atomically claim the oldest available pending job.
   * Uses BEGIN IMMEDIATE so concurrent writers serialize on the write lock.
   */
  claimNext(input: ClaimJobInput): Job | null {
    const run = this.db.transaction(() => {
      const row = this.db
        .prepare(
          `UPDATE jobs
           SET state = 'processing',
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
             WHERE state = 'pending'
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
         SET state = 'completed',
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

  markFailed(input: FailJobInput): Job {
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE jobs
         SET state = 'failed',
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
         SET state = 'dead',
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

    this.appendHistory(input.jobId, "dead", input.error);
    return this.getById(input.jobId)!;
  }

  /** Return job to pending with a future available_at (delayed retry). */
  scheduleRetry(input: ScheduleRetryInput): Job {
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE jobs
         SET state = 'pending',
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
      .prepare(
        `UPDATE jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND state = 'processing'`,
      )
      .run(leaseUntil, nowIso(), jobId);
  }

  recoverExpiredLeases(now: string): RecoveredLease[] {
    const recover = this.db.transaction(() => {
      // Capture ownership before reset — RETURNING would only show cleared fields.
      const stale = this.db
        .prepare(
          `SELECT id, worker_id, lease_until FROM jobs
           WHERE state = 'processing'
             AND lease_until IS NOT NULL
             AND lease_until < ?`,
        )
        .all(now) as Array<{
        id: string;
        worker_id: string | null;
        lease_until: string | null;
      }>;

      if (stale.length === 0) {
        return [] as RecoveredLease[];
      }

      const reset = this.db.prepare(
        `UPDATE jobs
         SET state = 'pending',
             worker_id = NULL,
             lease_until = NULL,
             started_at = NULL,
             updated_at = ?,
             available_at = ?
         WHERE id = ?`,
      );

      const recovered: RecoveredLease[] = [];
      for (const row of stale) {
        reset.run(now, now, row.id);
        this.appendHistory(
          row.id,
          "recovered",
          `reason=lease_expired; previous_worker=${row.worker_id}; previous_lease_until=${row.lease_until}`,
        );
        recovered.push({
          jobId: row.id,
          previousWorkerId: row.worker_id,
          previousLeaseUntil: row.lease_until,
          recoveredAt: now,
        });
      }
      return recovered;
    });

    return recover();
  }

  listDead(limit: number): Job[] {
    return this.list({ state: "dead", limit });
  }

  requeueDead(jobId: string): Job | null {
    const job = this.getById(jobId);
    if (!job || job.state !== "dead") {
      return null;
    }

    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE jobs
         SET state = 'pending',
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
         WHERE id = ? AND state = 'dead'`,
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
