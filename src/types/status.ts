/** Assignment job states — exposed as `state` in CLI/JSON. */
export const JOB_STATES = [
  "pending",
  "processing",
  "completed",
  "failed",
  "dead",
] as const;

export type JobState = (typeof JOB_STATES)[number];

/** @deprecated use JobState */
export type JobStatus = JobState;

export const WORKER_STATUSES = ["active", "stopping", "stopped"] as const;

export type WorkerStatus = (typeof WORKER_STATUSES)[number];

export function isJobState(value: string): value is JobState {
  return (JOB_STATES as readonly string[]).includes(value);
}

/** Alias for older call sites. */
export const isJobStatus = isJobState;
