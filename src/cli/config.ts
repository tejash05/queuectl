import type { Command } from "commander";
import { openDatabase, closeDatabase } from "../database/database.js";
import { assertConfigKey, ConfigRepository } from "../repositories/ConfigRepository.js";
import { EXIT_ERROR, EXIT_USAGE } from "../utils/constants.js";
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
    .argument("<key>", "Config key")
    .argument("<value>", "Config value")
    .action((key: string, value: string) => {
      const db = openDatabase();
      try {
        const configKey = assertConfigKey(key);
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) {
          throw new Error(`Value must be a number: ${value}`);
        }
        const entry = new ConfigRepository(db).set(configKey, numeric);
        success(`Set ${entry.key}=${entry.value}`);
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_ERROR;
      } finally {
        closeDatabase(db);
      }
    });
}
