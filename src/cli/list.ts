import type { Command } from "commander";
import { closeDatabase, openDatabase } from "../database/database.js";
import { JobService } from "../core/JobService.js";
import { ConfigRepository } from "../repositories/ConfigRepository.js";
import { JobRepository } from "../repositories/JobRepository.js";
import { isJobState } from "../types/status.js";
import { EXIT_ERROR, EXIT_USAGE } from "../utils/constants.js";
import { failure, printTable, truncate } from "./format.js";

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List jobs")
    .option("--state <state>", "Filter by state")
    .option("--json", "Print only a JSON array to stdout")
    .option("--limit <n>", "Optional maximum rows (default: all matching jobs)")
    .action((options: { state?: string; json?: boolean; limit?: string }) => {
      let limit: number | undefined;
      if (options.limit !== undefined) {
        limit = Number(options.limit);
        if (!Number.isInteger(limit) || limit <= 0) {
          failure("--limit must be a positive integer");
          process.exitCode = EXIT_USAGE;
          return;
        }
      }

      if (options.state && !isJobState(options.state)) {
        failure(`Invalid state: ${options.state}`);
        process.exitCode = EXIT_USAGE;
        return;
      }

      const db = openDatabase();
      try {
        const service = new JobService(new JobRepository(db), new ConfigRepository(db));
        const filter = {
          ...(options.state && isJobState(options.state) ? { state: options.state } : {}),
          ...(limit !== undefined ? { limit } : {}),
        };

        if (options.json) {
          // Assignment contract: ONLY a JSON array on stdout (no logs/headers/colors).
          // Logger writes to stderr; this is the sole stdout write.
          process.stdout.write(`${JSON.stringify(service.listJson(filter))}\n`);
          return;
        }

        const jobs = service.list(filter);
        if (jobs.length === 0) {
          console.log("No jobs found.");
          return;
        }

        printTable(
          ["ID", "State", "Attempts", "Command", "Available At", "Worker"],
          jobs.map((job) => [
            truncate(job.id, 36),
            job.state,
            `${job.attempts}/${job.maxRetries}`,
            truncate(job.command, 40),
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
