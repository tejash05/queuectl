import type { SqliteDatabase } from "../database/database.js";
import { mapConfigRow, type ConfigEntry, type ConfigRow } from "../models/Config.js";
import {
  CONFIG_KEYS,
  CONFIG_RULES,
  DEFAULT_CONFIG,
  MIN_LEASE_TO_HEARTBEAT_RATIO,
  type ConfigKey,
} from "../utils/constants.js";
import { nowIso } from "../utils/time.js";

export class ConfigRepository {
  constructor(private readonly db: SqliteDatabase) {}

  getAll(): ConfigEntry[] {
    const rows = this.db.prepare(`SELECT key, value, updated_at FROM config ORDER BY key`).all() as ConfigRow[];
    return rows.map(mapConfigRow);
  }

  get(key: ConfigKey): number {
    const row = this.db
      .prepare(`SELECT key, value, updated_at FROM config WHERE key = ?`)
      .get(key) as ConfigRow | undefined;

    if (!row) {
      return DEFAULT_CONFIG[key];
    }

    // Values written before validation existed (or edited in the file directly)
    // must not propagate NaN into lease/backoff arithmetic.
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : DEFAULT_CONFIG[key];
  }

  getMany(keys: ConfigKey[]): Record<ConfigKey, number> {
    const result = { ...DEFAULT_CONFIG } as Record<ConfigKey, number>;
    for (const key of keys) {
      result[key] = this.get(key);
    }
    return result;
  }

  set(key: ConfigKey, value: number): ConfigEntry {
    if (!CONFIG_KEYS.includes(key)) {
      throw new Error(`Unknown config key: ${key}`);
    }

    validateConfigValue(key, value);
    this.validateAgainstRelatedKeys(key, value);

    const updatedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, String(value), updatedAt);

    return { key, value, updatedAt };
  }

  /**
   * lease-timeout-ms and heartbeat-interval-ms are only safe as a pair: if a
   * lease can expire before the next heartbeat renews it, recovery reclaims
   * jobs that are still running and they execute twice.
   */
  private validateAgainstRelatedKeys(key: ConfigKey, value: number): void {
    if (key !== "lease-timeout-ms" && key !== "heartbeat-interval-ms") {
      return;
    }

    const lease = key === "lease-timeout-ms" ? value : this.get("lease-timeout-ms");
    const heartbeat =
      key === "heartbeat-interval-ms" ? value : this.get("heartbeat-interval-ms");

    if (lease < heartbeat * MIN_LEASE_TO_HEARTBEAT_RATIO) {
      throw new Error(
        `lease-timeout-ms (${lease}) must be at least ${MIN_LEASE_TO_HEARTBEAT_RATIO}x ` +
          `heartbeat-interval-ms (${heartbeat}); adjust the other key first`,
      );
    }
  }
}

export function validateConfigValue(key: ConfigKey, value: number): void {
  const rule = CONFIG_RULES[key];

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number (got: ${String(value)})`);
  }
  if (rule.integer && !Number.isInteger(value)) {
    throw new Error(`${key} must be an integer (got: ${value}) — ${rule.hint}`);
  }
  if (value < rule.min || value > rule.max) {
    throw new Error(
      `${key} must be between ${rule.min} and ${rule.max} (got: ${value}) — ${rule.hint}`,
    );
  }
}

export function assertConfigKey(key: string): ConfigKey {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Unknown config key: ${key}. Valid keys: ${CONFIG_KEYS.join(", ")}`);
  }
  return key as ConfigKey;
}
