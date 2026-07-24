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
import { EXIT_ERROR } from "../utils/constants.js";
import { onShutdown } from "../utils/signals.js";
import { failure, success } from "./format.js";

export function registerWorkerCommand(program: Command): void {
  const worker = program.command("worker").description("Manage worker processes");

  worker
    .command("start")
    .description("Start a worker process")
    .option("--id <workerId>", "Optional worker ID")
    .action(async (options: { id?: string }) => {
      const db = openDatabase();
      const config = new ConfigRepository(db);
      const jobs = new JobRepository(db);
      const workers = new WorkerRepository(db);
      const workerService = new WorkerService(workers);

      let scheduler: Scheduler | null = null;
      let disposeSignals: (() => void) | null = null;

      try {
        const registered = workerService.register(
          options.id ? { id: options.id } : undefined,
        );
        success(`Worker ${registered.id} started (pid ${registered.pid})`);

        scheduler = new Scheduler({
          workerId: registered.id,
          workerService,
          jobs,
          config,
          recovery: new RecoveryService(jobs),
          retry: new RetryService(jobs, config),
          executor: new JobExecutor(),
        });

        disposeSignals = onShutdown((signal) => {
          scheduler?.requestShutdown(signal);
        });

        await scheduler.run();
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
    .description("Request a worker to stop gracefully")
    .argument("<workerId>", "Worker ID to stop")
    .action((workerId: string) => {
      const db = openDatabase();
      try {
        const workerService = new WorkerService(new WorkerRepository(db));
        const workerRow = workerService.requestStop(workerId);
        success(`Stop requested for worker ${workerRow.id} (status=${workerRow.status})`);
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_ERROR;
      } finally {
        closeDatabase(db);
      }
    });
}
