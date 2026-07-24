import type { Command } from "commander";
import { failure } from "./format.js";
import { EXIT_ERROR } from "../utils/constants.js";

export function registerDlqCommand(program: Command): void {
  const dlq = program.command("dlq").description("Manage the dead letter queue");

  dlq
    .command("list")
    .description("List dead-lettered jobs")
    .option("--limit <n>", "Maximum rows", "50")
    .action(async () => {
      failure("dlq list is not implemented yet");
      process.exitCode = EXIT_ERROR;
    });

  dlq
    .command("retry")
    .description("Requeue a dead job (or all with --all)")
    .argument("[jobId]", "Job ID to retry")
    .option("--all", "Retry all dead jobs")
    .action(async () => {
      failure("dlq retry is not implemented yet");
      process.exitCode = EXIT_ERROR;
    });
}
