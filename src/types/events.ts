/**
 * Audit trail written to job_history. One entry per state transition, so the
 * event names mirror the job states: `failed` is a retryable failure with a
 * backoff deadline in its detail, `dead` is the terminal DLQ transition.
 */
export const JOB_EVENTS = [
  "enqueued",
  "claimed",
  "completed",
  "failed",
  "dead",
  "recovered",
  "requeued",
] as const;

export type JobEvent = (typeof JOB_EVENTS)[number];
