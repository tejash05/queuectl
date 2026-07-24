import type { Command } from "commander";
import { failure } from "./format.js";
import { EXIT_ERROR } from "../utils/constants.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show queue and worker status")
    .action(async () => {
      failure("status is not implemented yet");
      process.exitCode = EXIT_ERROR;
    });
}
