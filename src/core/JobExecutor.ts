import { spawn } from "node:child_process";
import type { Job } from "../models/Job.js";
import { logger } from "../utils/logger.js";

export interface ExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export interface ExecuteOptions {
  truncateBytes: number;
}

export class JobExecutor {
  execute(job: Job, options: ExecuteOptions): Promise<ExecutionResult> {
    const [bin, ...args] = job.command;
    if (!bin) {
      return Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: "",
        error: "Empty command",
      });
    }

    logger.debug("Executing job", { job_id: job.id, bin, args });

    return new Promise((resolve) => {
      const child = spawn(bin, args, {
        cwd: job.cwd ?? process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result: ExecutionResult) => {
        if (settled) return;
        settled = true;
        resolve({
          ...result,
          stdout: truncate(result.stdout, options.truncateBytes),
          stderr: truncate(result.stderr, options.truncateBytes),
        });
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });

      child.on("error", (error) => {
        finish({
          exitCode: 1,
          stdout,
          stderr,
          error: error.message,
        });
      });

      child.on("close", (code, signal) => {
        if (signal) {
          finish({
            exitCode: code ?? 1,
            stdout,
            stderr,
            error: `terminated by signal ${signal}`,
          });
          return;
        }
        finish({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });
    });
  }
}

function truncate(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }

  let out = "";
  for (const char of value) {
    if (Buffer.byteLength(out + char, "utf8") > maxBytes) break;
    out += char;
  }
  return `${out}\n...[truncated]`;
}
