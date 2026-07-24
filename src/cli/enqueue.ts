import type { Command } from "commander";
import { closeDatabase, openDatabase } from "../database/database.js";
import { JobService } from "../core/JobService.js";
import { ConfigRepository } from "../repositories/ConfigRepository.js";
import { JobRepository } from "../repositories/JobRepository.js";
import { EXIT_ERROR, EXIT_USAGE } from "../utils/constants.js";
import { failure, success } from "./format.js";

export function registerEnqueueCommand(program: Command): void {
  program
    .command("enqueue")
    .description("Enqueue a shell command as a background job")
    .argument("<command...>", "Command and arguments to run")
    .option("--cwd <path>", "Working directory for the job")
    .action((commandParts: string[], options: { cwd?: string }) => {
      const command = commandParts.filter((part) => part !== "--");

      if (command.length === 0) {
        failure("Command is required. Usage: queuectl enqueue -- <command> [args...]");
        process.exitCode = EXIT_USAGE;
        return;
      }

      const db = openDatabase();
      try {
        const service = new JobService(new JobRepository(db), new ConfigRepository(db));
        const job = service.enqueue({
          command,
          ...(options.cwd ? { cwd: options.cwd } : {}),
        });
        success(`Enqueued job ${job.id}`);
        console.log(job.id);
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_ERROR;
      } finally {
        closeDatabase(db);
      }
    });
}
