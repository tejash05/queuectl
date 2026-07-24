import type { Command } from "commander";
import { failure } from "./format.js";
import { EXIT_ERROR } from "../utils/constants.js";

export function registerWorkerCommand(program: Command): void {
  const worker = program.command("worker").description("Manage worker processes");

  worker
    .command("start")
    .description("Start a worker process")
    .option("--id <workerId>", "Optional worker ID")
    .action(async () => {
      failure("worker start is not implemented yet");
      process.exitCode = EXIT_ERROR;
    });

  worker
    .command("stop")
    .description("Request a worker to stop gracefully")
    .argument("<workerId>", "Worker ID to stop")
    .action(async () => {
      failure("worker stop is not implemented yet");
      process.exitCode = EXIT_ERROR;
    });
}
