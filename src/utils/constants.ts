/**
 * Durable config defaults.
 * Assignment CLI keys use hyphens: max-retries, backoff-base.
 * backoff-base is the exponent base for delay = base^attempts (seconds).
 */
export const DEFAULT_CONFIG = {
  "max-retries": 3,
  "backoff-base": 2,
  "lease-timeout-ms": 30_000,
  "heartbeat-interval-ms": 5_000,
  // Recovery runs on its own timer, not in the claim/execute loop, so a worker
  // busy with a long job still reclaims other workers' expired leases.
  "recovery-interval-ms": 5_000,
  "poll-interval-ms": 1_000,
  "output-truncate-bytes": 8_192,
} as const;

export type ConfigKey = keyof typeof DEFAULT_CONFIG;

export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as ConfigKey[];

export interface ConfigRule {
  integer: boolean;
  min: number;
  max: number;
  hint: string;
}

/**
 * Accepted range per key. Every value here is read by the running system, and
 * every bound exists to stop a single `config set` from making the queue
 * unusable — a fractional max-retries would never equal attempts, a
 * backoff-base below 1 would retry with zero delay in a hot loop, and a
 * sub-second lease would expire mid-execution and hand live jobs to recovery.
 */
export const CONFIG_RULES: Record<ConfigKey, ConfigRule> = {
  "max-retries": {
    integer: true,
    min: 0,
    max: 1_000,
    hint: "retries allowed after the first attempt",
  },
  "backoff-base": {
    integer: false,
    min: 1,
    max: 60,
    hint: "exponent base for delay = base^attempts seconds; below 1 means no delay",
  },
  "lease-timeout-ms": {
    integer: true,
    min: 1_000,
    max: 86_400_000,
    hint: "how long a claim stays valid without a heartbeat",
  },
  "heartbeat-interval-ms": {
    integer: true,
    min: 100,
    max: 3_600_000,
    hint: "must be at most half of lease-timeout-ms so leases are renewed in time",
  },
  "recovery-interval-ms": {
    integer: true,
    min: 100,
    max: 3_600_000,
    hint: "how often each worker process scans for expired leases",
  },
  "poll-interval-ms": {
    integer: true,
    min: 10,
    max: 3_600_000,
    hint: "idle sleep between claim attempts",
  },
  "output-truncate-bytes": {
    integer: true,
    min: 0,
    max: 10_485_760,
    hint: "captured stdout/stderr cap per job",
  },
};

/** Renewal must fit inside the lease at least twice, or leases expire mid-job. */
export const MIN_LEASE_TO_HEARTBEAT_RATIO = 2;

export const EXIT_SUCCESS = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

export const APP_NAME = "queuectl";
export const APP_VERSION = "0.1.0";

export const DEFAULT_DB_FILENAME = "queuectl.sqlite";
