import type { Command } from "commander";
import { closeDatabase, openDatabase } from "../database/database.js";
import { JobService } from "../core/JobService.js";
import { toJobJson } from "../models/Job.js";
import { ConfigRepository } from "../repositories/ConfigRepository.js";
import { JobRepository } from "../repositories/JobRepository.js";
import { EXIT_ERROR, EXIT_USAGE } from "../utils/constants.js";
import { failure } from "./format.js";

export function registerEnqueueCommand(program: Command): void {
  program
    .command("enqueue")
    .description('Enqueue a job from JSON: {"id":"job1","command":"echo hello"}')
    .argument("<jobJson>", "Job JSON object")
    .action((jobJson: string) => {
      if (!jobJson || jobJson.trim() === "") {
        failure(`Usage: queuectl enqueue '{"id":"job1","command":"echo hello"}'`);
        process.exitCode = EXIT_USAGE;
        return;
      }

      const db = openDatabase();
      try {
        const service = new JobService(new JobRepository(db), new ConfigRepository(db));
        const job = service.enqueueFromJson(jobJson);
        // Machine-readable job contract on stdout (logs stay on stderr)
        console.log(JSON.stringify(toJobJson(job)));
      } catch (error) {
        failure(error instanceof Error ? error.message : String(error));
        process.exitCode = EXIT_ERROR;
      } finally {
        closeDatabase(db);
      }
    });
}
