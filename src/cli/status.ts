import type { Command } from "commander";
import { closeDatabase, openDatabase } from "../database/database.js";
import { JobService } from "../core/JobService.js";
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
        const jobService = new JobService(new JobRepository(db), new ConfigRepository(db));
        const workerService = new WorkerService(new WorkerRepository(db));

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

        const activeWorkers = workerService.list().filter((w) => w.status !== "stopped");
        if (activeWorkers.length > 0) {
          console.log("\nActive / Stopping Workers");
          printTable(
            ["ID", "Host", "PID", "Status", "Heartbeat"],
            activeWorkers.map((w) => [
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
