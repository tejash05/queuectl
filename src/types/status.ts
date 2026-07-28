/**
 * Assignment job states — exposed as `state` in CLI/JSON.
 *
 *   pending    waiting to be claimed (new, or reset by crash recovery)
 *   processing claimed by a worker and executing under a lease
 *   completed  exited 0 (terminal)
 *   failed     failed but retryable — waiting out its backoff in available_at
 *   dead       retries exhausted, moved to the DLQ (terminal until `dlq retry`)
 */
export const JOB_STATES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "dead",
] as const;

export type JobState = (typeof JOB_STATES)[number];

export const WORKER_STATUSES = ["active", "stopping", "stopped"] as const;

export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export function isJobState(value: string): value is JobState {
  return (JOB_STATES as readonly string[]).includes(value);
}
