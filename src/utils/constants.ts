/** Default configuration values seeded into the config table. */
export const DEFAULT_CONFIG = {
  max_retries: 3,
  backoff_base_ms: 1000,
  lease_timeout_ms: 30_000,
  heartbeat_interval_ms: 5_000,
  poll_interval_ms: 1_000,
  output_truncate_bytes: 8_192,
  shutdown_grace_ms: 10_000,
} as const;

export type ConfigKey = keyof typeof DEFAULT_CONFIG;

export const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as ConfigKey[];

export const EXIT_SUCCESS = 0;
export const EXIT_ERROR = 1;
export const EXIT_USAGE = 2;

export const APP_NAME = "queuectl";
export const APP_VERSION = "0.1.0";

export const DEFAULT_DB_FILENAME = "queuectl.sqlite";
