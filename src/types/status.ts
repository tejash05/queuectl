export const JOB_STATUSES = [
  "pending",
  "scheduled",
  "running",
  "completed",
  "failed",
  "dead",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const WORKER_STATUSES = ["active", "stopping", "stopped"] as const;

export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUSES as readonly string[]).includes(value);
}
