import type { Command } from "commander";
import { openDatabase, closeDatabase } from "../database/database.js";
import { assertConfigKey, ConfigRepository } from "../repositories/ConfigRepository.js";
import { EXIT_USAGE } from "../utils/constants.js";
import { failure, printTable, success } from "./format.js";

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("Manage persistent configuration");

  config
    .command("get")
    .description("Get configuration value(s)")
    .argument("[key]", "Config key (omit to list all)")
    .action((key?: string) => {
      const db = openDatabase();
      try {
        const repo = new ConfigRepository(db);
        if (key) {
          const configKey = assertConfigKey(key);
          console.log(String(repo.get(configKey)));
          return;
        }

        const rows = repo.getAll().map((entry) => [entry.key, String(entry.value), entry.updatedAt]);
        printTable(["Key", "Value", "Updated At"], rows);
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_USAGE;
      } finally {
        closeDatabase(db);
      }
    });

  config
    .command("set")
    .description("Set a configuration value")
    .argument("<key>", "Config key (e.g. max-retries, backoff-base)")
    .argument("[value]", "Config value")
    // Commander treats a leading '-' as an option, so `config set max-retries -1`
    // would otherwise never reach validation. Unknown tokens are recovered below.
    .allowUnknownOption()
    .action((key: string, value: string | undefined) => {
      const db = openDatabase();
      try {
        const configKey = assertConfigKey(key);
        const raw = resolveConfigValue(key, value);
        const numeric = raw.trim() === "" ? Number.NaN : Number(raw);
        if (!Number.isFinite(numeric)) {
          throw new Error(`${key} must be a number (got: ${raw})`);
        }
        const entry = new ConfigRepository(db).set(configKey, numeric);
        success(`Set ${entry.key}=${entry.value}`);
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_USAGE;
      } finally {
        closeDatabase(db);
      }
    });
}

/**
 * Commander swallows tokens that look like flags (`-1`). Recover the raw token
 * from process.argv so validation — not the parser — rejects negative numbers.
 */
function resolveConfigValue(key: string, value: string | undefined): string {
  if (value !== undefined) return value;
  const argv = process.argv;
  const keyIndex = argv.lastIndexOf(key);
  if (keyIndex >= 0 && argv[keyIndex + 1] !== undefined) {
    return argv[keyIndex + 1];
  }
  throw new Error(`Missing value for ${key}`);
}
