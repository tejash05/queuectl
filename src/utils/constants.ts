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
  "poll-interval-ms": 1_000,
  "output-truncate-bytes": 8_192,
  "shutdown-grace-ms": 10_000,
} as const;

export type ConfigKey = keyof typeof DEFAULT_CONFIG;

export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as ConfigKey[];

export const EXIT_SUCCESS = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

export const APP_NAME = "queuectl";
export const APP_VERSION = "0.1.0";

export const DEFAULT_DB_FILENAME = "queuectl.sqlite";
