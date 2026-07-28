import type { Command } from "commander";
import { closeDatabase, openDatabase } from "../database/database.js";
import { JobService } from "../core/JobService.js";
import { RecoveryService } from "../core/RecoveryService.js";
import { WorkerService } from "../core/WorkerService.js";
import { ConfigRepository } from "../repositories/ConfigRepository.js";
import { JobRepository } from "../repositories/JobRepository.js";
import { WorkerRepository } from "../repositories/WorkerRepository.js";
import { JOB_STATES } from "../types/status.js";
import { EXIT_ERROR } from "../utils/constants.js";
import { failure, printTable, truncate } from "./format.js";

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("Show queue and worker status")
    .action(() => {
      const db = openDatabase();
      try {
        const config = new ConfigRepository(db);
        const jobs = new JobRepository(db);
        const workers = new WorkerRepository(db);
        const jobService = new JobService(jobs, config);
        const workerService = new WorkerService(workers);

        // Reclaim expired job leases and mark SIGKILL zombies stopped before display.
        new RecoveryService(jobs, workers, config).recover();

        const jobCounts = jobService.counts();
        const workerCounts = workerService.counts();

        console.log("Jobs");
        printTable(
          ["State", "Count"],
          JOB_STATES.map((state) => [state, String(jobCounts[state] ?? 0)]),
        );

        console.log("\nWorkers");
        printTable(
          ["Status", "Count"],
          ["active", "stopping", "stopped"].map((status) => [
            status,
            String(workerCounts[status] ?? 0),
          ]),
        );

        const liveWorkers = workerService.list().filter((w) => w.status !== "stopped");
        if (liveWorkers.length > 0) {
          console.log("\nActive / Stopping Workers");
          printTable(
            ["ID", "Host", "PID", "Status", "Heartbeat"],
            liveWorkers.map((w) => [
              truncate(w.id, 36),
              w.hostname,
              String(w.pid),
              w.status,
              w.lastHeartbeatAt,
            ]),
          );
        }
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_ERROR;
      } finally {
        closeDatabase(db);
      }
    });
}
