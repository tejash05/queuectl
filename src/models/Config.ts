import type { ConfigKey } from "../utils/constants.js";

export interface ConfigEntry {
  key: ConfigKey;
  value: number;
  updatedAt: string;
}

export interface ConfigRow {
  key: string;
  value: string;
  updated_at: string;
}

export function mapConfigRow(row: ConfigRow): ConfigEntry {
  return {
    key: row.key as ConfigKey,
    value: Number(row.value),
    updatedAt: row.updated_at,
  };
}
