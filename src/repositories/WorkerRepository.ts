import type { SqliteDatabase } from "../database/database.js";
import { mapWorkerRow, type Worker, type WorkerRow } from "../models/Worker.js";
import type { WorkerStatus } from "../types/status.js";
import { createId } from "../utils/id.js";
import { nowIso } from "../utils/time.js";

export interface RegisterWorkerInput {
  id?: string;
  hostname: string;
  pid: number;
}

export class WorkerRepository {
  constructor(private readonly db: SqliteDatabase) {}

  register(input: RegisterWorkerInput): Worker {
    const id = input.id ?? createId();
    const ts = nowIso();

    this.db
      .prepare(
        `INSERT INTO workers (id, hostname, pid, status, last_heartbeat_at, started_at, stopped_at)
         VALUES (?, ?, ?, 'active', ?, ?, NULL)`,
      )
      .run(id, input.hostname, input.pid, ts, ts);

    return this.getById(id)!;
  }

  getById(id: string): Worker | null {
    const row = this.db.prepare(`SELECT * FROM workers WHERE id = ?`).get(id) as WorkerRow | undefined;
    return row ? mapWorkerRow(row) : null;
  }

  list(status?: WorkerStatus): Worker[] {
    if (status) {
      const rows = this.db
        .prepare(`SELECT * FROM workers WHERE status = ? ORDER BY started_at DESC`)
        .all(status) as WorkerRow[];
      return rows.map(mapWorkerRow);
    }

    const rows = this.db
      .prepare(`SELECT * FROM workers ORDER BY started_at DESC`)
      .all() as WorkerRow[];
    return rows.map(mapWorkerRow);
  }

  heartbeat(workerId: string): void {
    this.db
      .prepare(`UPDATE workers SET last_heartbeat_at = ? WHERE id = ? AND status IN ('active', 'stopping')`)
      .run(nowIso(), workerId);
  }

  requestStop(workerId: string): Worker {
    const worker = this.getById(workerId);
    if (!worker) {
      throw new Error(`Worker not found: ${workerId}`);
    }
    if (worker.status === "stopped") {
      return worker;
    }

    this.db
      .prepare(`UPDATE workers SET status = 'stopping', last_heartbeat_at = ? WHERE id = ?`)
      .run(nowIso(), workerId);

    return this.getById(workerId)!;
  }

  /** Cooperative stop for every active/stopping worker (assignment: `worker stop`). */
  requestStopAll(): Worker[] {
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE workers
         SET status = 'stopping', last_heartbeat_at = ?
         WHERE status IN ('active', 'stopping')`,
      )
      .run(ts);

    return this.list("stopping");
  }

  markStopped(workerId: string): Worker {
    const ts = nowIso();
    this.db
      .prepare(`UPDATE workers SET status = 'stopped', stopped_at = ?, last_heartbeat_at = ? WHERE id = ?`)
      .run(ts, ts, workerId);
    return this.getById(workerId)!;
  }

  /**
   * Mark workers whose heartbeats expired as stopped.
   * Used after SIGKILL/crash when markStopped never ran.
   */
  markStaleAsStopped(staleBefore: string, now: string = nowIso()): Worker[] {
    const rows = this.db
      .prepare(
        `UPDATE workers
         SET status = 'stopped',
             stopped_at = ?,
             last_heartbeat_at = last_heartbeat_at
         WHERE status IN ('active', 'stopping')
           AND last_heartbeat_at < ?
         RETURNING *`,
      )
      .all(now, staleBefore) as WorkerRow[];

    return rows.map(mapWorkerRow);
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare(`SELECT status, COUNT(*) AS count FROM workers GROUP BY status`)
      .all() as Array<{ status: string; count: number }>;

    const counts: Record<string, number> = {};
    for (const row of rows) {
      counts[row.status] = row.count;
    }
    return counts;
  }
}
