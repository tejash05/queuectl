import type { Command } from "commander";
import { closeDatabase, openDatabase } from "../database/database.js";
import { JobService } from "../core/JobService.js";
import { ConfigRepository } from "../repositories/ConfigRepository.js";
import { JobRepository } from "../repositories/JobRepository.js";
import { isJobStatus } from "../types/status.js";
import { EXIT_ERROR, EXIT_USAGE } from "../utils/constants.js";
import { failure, printTable, truncate } from "./format.js";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List jobs")
    .option("--status <status>", "Filter by status")
    .option("--limit <n>", "Maximum rows", "50")
    .action((options: { status?: string; limit: string }) => {
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        failure("--limit must be a positive integer");
        process.exitCode = EXIT_USAGE;
        return;
      }

      if (options.status && !isJobStatus(options.status)) {
        failure(`Invalid status: ${options.status}`);
        process.exitCode = EXIT_USAGE;
        return;
      }

      const db = openDatabase();
      try {
        const service = new JobService(new JobRepository(db), new ConfigRepository(db));
        const jobs = service.list({
          ...(options.status && isJobStatus(options.status) ? { status: options.status } : {}),
          limit,
        });

        if (jobs.length === 0) {
          console.log("No jobs found.");
          return;
        }

        printTable(
          ["ID", "Status", "Attempts", "Command", "Available At", "Worker"],
          jobs.map((job) => [
            truncate(job.id, 36),
            job.status,
            `${job.attempts}/${job.maxRetries}`,
            truncate(job.command.join(" "), 40),
            job.availableAt,
            job.workerId ? truncate(job.workerId, 8) : "-",
          ]),
        );
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_ERROR;
      } finally {
        closeDatabase(db);
      }
    });
}
