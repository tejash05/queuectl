import type { Command } from "commander";
import { failure } from "./format.js";
import { EXIT_ERROR } from "../utils/constants.js";

export function registerConfigCommand(program: Command): void {
  const config = program.command("config").description("Manage persistent configuration");

  config
    .command("get")
    .description("Get configuration value(s)")
    .argument("[key]", "Config key (omit to list all)")
    .action(async () => {
      failure("config get is not implemented yet");
      process.exitCode = EXIT_ERROR;
    });

  config
    .command("set")
    .description("Set a configuration value")
    .argument("<key>", "Config key")
    .argument("<value>", "Config value")
    .action(async () => {
      failure("config set is not implemented yet");
      process.exitCode = EXIT_ERROR;
    });
}
