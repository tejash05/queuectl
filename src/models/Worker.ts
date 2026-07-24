import type { WorkerStatus } from "../types/status.js";

export interface Worker {
  id: string;
  hostname: string;
  pid: number;
  status: WorkerStatus;
  lastHeartbeatAt: string;
  startedAt: string;
  stoppedAt: string | null;
}

export interface WorkerRow {
  id: string;
  hostname: string;
  pid: number;
  status: WorkerStatus;
  last_heartbeat_at: string;
  started_at: string;
  stopped_at: string | null;
}

export function mapWorkerRow(row: WorkerRow): Worker {
  return {
    id: row.id,
    hostname: row.hostname,
    pid: row.pid,
    status: row.status,
    lastHeartbeatAt: row.last_heartbeat_at,
    startedAt: row.started_at,
    stoppedAt: row.stopped_at,
  };
}
