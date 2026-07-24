import type { Command } from "commander";
import { closeDatabase, openDatabase } from "../database/database.js";
import { JobExecutor } from "../core/JobExecutor.js";
import { RecoveryService } from "../core/RecoveryService.js";
import { RetryService } from "../core/RetryService.js";
import { Scheduler } from "../core/Scheduler.js";
import { WorkerService } from "../core/WorkerService.js";
import { ConfigRepository } from "../repositories/ConfigRepository.js";
import { JobRepository } from "../repositories/JobRepository.js";
import { WorkerRepository } from "../repositories/WorkerRepository.js";
import { EXIT_ERROR, EXIT_USAGE } from "../utils/constants.js";
import { onShutdown } from "../utils/signals.js";
import { failure, success } from "./format.js";

export function registerWorkerCommand(program: Command): void {
  const worker = program.command("worker").description("Manage worker processes");

  worker
    .command("start")
    .description("Start worker process(es) in the foreground")
    .option("--count <n>", "Number of concurrent workers", "1")
    .action(async (options: { count: string }) => {
      const count = Number(options.count);
      if (!Number.isInteger(count) || count < 1) {
        failure("--count must be a positive integer");
        process.exitCode = EXIT_USAGE;
        return;
      }

      const db = openDatabase();
      const config = new ConfigRepository(db);
      const jobs = new JobRepository(db);
      const workers = new WorkerRepository(db);
      const workerService = new WorkerService(workers);
      const recovery = new RecoveryService(jobs);
      const retry = new RetryService(jobs, config);
      const executor = new JobExecutor();

      const schedulers: Scheduler[] = [];
      let disposeSignals: (() => void) | null = null;

      try {
        for (let i = 0; i < count; i += 1) {
          const registered = workerService.register();
          const scheduler = new Scheduler({
            workerId: registered.id,
            workerService,
            jobs,
            config,
            recovery,
            retry,
            executor,
          });
          schedulers.push(scheduler);
        }

        success(`Started ${count} worker(s) in foreground (pid ${process.pid})`);

        disposeSignals = onShutdown((signal) => {
          for (const scheduler of schedulers) {
            scheduler.requestShutdown(signal);
          }
        });

        await Promise.all(schedulers.map((scheduler) => scheduler.run()));
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_ERROR;
      } finally {
        disposeSignals?.();
        closeDatabase(db);
      }
    });

  worker
    .command("stop")
    .description("Request all active workers to stop gracefully")
    .action(() => {
      const db = openDatabase();
      try {
        const workerService = new WorkerService(new WorkerRepository(db));
        const stopped = workerService.requestStopAll();
        success(`Stop requested for ${stopped.length} worker(s)`);
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_ERROR;
      } finally {
        closeDatabase(db);
      }
    });
}
