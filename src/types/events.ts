export const JOB_EVENTS = [
  "enqueued",
  "claimed",
  "completed",
  "failed",
  "retry_scheduled",
  "dead",
  "recovered",
  "requeued",
] as const;

export type JobEvent = (typeof JOB_EVENTS)[number];
