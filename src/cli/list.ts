import type { Command } from "commander";
import { failure } from "./format.js";
import { EXIT_ERROR } from "../utils/constants.js";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List jobs")
    .option("--status <status>", "Filter by status")
    .option("--limit <n>", "Maximum rows", "50")
    .action(async () => {
      failure("list is not implemented yet");
      process.exitCode = EXIT_ERROR;
    });
}
