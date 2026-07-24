import type { Command } from "commander";
import { failure } from "./format.js";
import { EXIT_ERROR } from "../utils/constants.js";

export function registerEnqueueCommand(program: Command): void {
  program
    .command("enqueue")
    .description("Enqueue a shell command as a background job")
    .argument("[command...]", "Command and arguments to run")
    .option("--cwd <path>", "Working directory for the job")
    .allowExcessArguments(true)
    .action(async () => {
      failure("enqueue is not implemented yet");
      process.exitCode = EXIT_ERROR;
    });
}
