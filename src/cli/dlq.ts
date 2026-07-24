import type { Command } from "commander";
import { closeDatabase, openDatabase } from "../database/database.js";
import { JobService } from "../core/JobService.js";
import { ConfigRepository } from "../repositories/ConfigRepository.js";
import { JobRepository } from "../repositories/JobRepository.js";
import { EXIT_ERROR, EXIT_USAGE } from "../utils/constants.js";
import { failure, printTable, success, truncate } from "./format.js";

export function registerDlqCommand(program: Command): void {
  const dlq = program.command("dlq").description("Manage the dead letter queue");

  dlq
    .command("list")
    .description("List dead-lettered jobs")
    .option("--limit <n>", "Maximum rows", "50")
    .action((options: { limit: string }) => {
      const limit = Number(options.limit);
      if (!Number.isInteger(limit) || limit <= 0) {
        failure("--limit must be a positive integer");
        process.exitCode = EXIT_USAGE;
        return;
      }

      const db = openDatabase();
      try {
        const service = new JobService(new JobRepository(db), new ConfigRepository(db));
        const jobs = service.listDead(limit);

        if (jobs.length === 0) {
          console.log("DLQ is empty.");
          return;
        }

        printTable(
          ["ID", "Attempts", "Command", "Last Error", "Finished At"],
          jobs.map((job) => [
            truncate(job.id, 36),
            `${job.attempts}/${job.maxRetries}`,
            truncate(job.command.join(" "), 40),
            truncate(job.lastError ?? "-", 40),
            job.finishedAt ?? "-",
          ]),
        );
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_ERROR;
      } finally {
        closeDatabase(db);
      }
    });

  dlq
    .command("retry")
    .description("Requeue a dead job (or all with --all)")
    .argument("[jobId]", "Job ID to retry")
    .option("--all", "Retry all dead jobs")
    .action((jobId: string | undefined, options: { all?: boolean }) => {
      if (!options.all && !jobId) {
        failure("Provide a job ID or --all");
        process.exitCode = EXIT_USAGE;
        return;
      }

      const db = openDatabase();
      try {
        const service = new JobService(new JobRepository(db), new ConfigRepository(db));
        if (options.all) {
          const count = service.retryAllDead();
          success(`Requeued ${count} dead job(s)`);
          return;
        }

        const job = service.retryDead(jobId!);
        success(`Requeued job ${job.id}`);
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_ERROR;
      } finally {
        closeDatabase(db);
      }
    });
}
