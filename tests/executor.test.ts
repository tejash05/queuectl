import { describe, expect, it } from "vitest";
import { JobExecutor } from "../src/core/JobExecutor.js";
import type { Job } from "../src/models/Job.js";

function fakeJob(command: string[]): Job {
  return {
    id: "test",
    command,
    cwd: null,
    status: "running",
    attempts: 1,
    maxRetries: 3,
    availableAt: new Date().toISOString(),
    workerId: "w",
    leaseUntil: null,
    lastError: null,
    exitCode: null,
    stdout: null,
    stderr: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
  };
}

describe("JobExecutor", () => {
  it("captures successful command output", async () => {
    const executor = new JobExecutor();
    const result = await executor.execute(fakeJob(["echo", "hello"]), { truncateBytes: 1024 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
  });

  it("captures non-zero exit codes", async () => {
    const executor = new JobExecutor();
    const result = await executor.execute(fakeJob(["false"]), { truncateBytes: 1024 });
    expect(result.exitCode).not.toBe(0);
  });
});
