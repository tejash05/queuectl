#!/usr/bin/env node
import { Command } from "commander";
import { APP_NAME, APP_VERSION, EXIT_ERROR } from "./utils/constants.js";
import { registerEnqueueCommand } from "./cli/enqueue.js";
import { registerWorkerCommand } from "./cli/worker.js";
import { registerStatusCommand } from "./cli/status.js";
import { registerListCommand } from "./cli/list.js";
import { registerConfigCommand } from "./cli/config.js";
import { registerDlqCommand } from "./cli/dlq.js";
import { failure } from "./cli/format.js";

async function main(): Promise<void> {
  const program = new Command();

  program
    .name(APP_NAME)
    .description("Production-inspired CLI background job queue")
    .version(APP_VERSION)
    .showHelpAfterError()
    .configureOutput({
      writeErr: (str) => process.stderr.write(str),
    });

  registerEnqueueCommand(program);
  registerWorkerCommand(program);
  registerStatusCommand(program);
  registerListCommand(program);
  registerConfigCommand(program);
  registerDlqCommand(program);

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  failure(message);
  process.exit(EXIT_ERROR);
});
