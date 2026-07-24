import type { SqliteDatabase } from "../database/database.js";
import { mapConfigRow, type ConfigEntry, type ConfigRow } from "../models/Config.js";
import {
  CONFIG_KEYS,
  DEFAULT_CONFIG,
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
    return Number(row.value);
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
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Config value must be a non-negative number: ${value}`);
    }

    const updatedAt = nowIso();
    this.db
      .prepare(
        `INSERT INTO config (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, String(value), updatedAt);

    return { key, value, updatedAt };
  }
}

export function assertConfigKey(key: string): ConfigKey {
  if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
    throw new Error(`Unknown config key: ${key}. Valid keys: ${CONFIG_KEYS.join(", ")}`);
  }
  return key as ConfigKey;
}
