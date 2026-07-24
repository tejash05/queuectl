import { describe, expect, it } from "vitest";
import { RetryService } from "../src/core/RetryService.js";
import { addMs, nowIso } from "../src/utils/time.js";
import { createTestContext } from "./helpers.js";

describe("RetryService", () => {
  it("schedules retry with exponential backoff when attempts remain", () => {
    const ctx = createTestContext();
    try {
      ctx.config.set("backoff_base_ms", 1000);
      const worker = ctx.workers.register({ hostname: "t", pid: 1 });
      const created = ctx.jobs.create({ command: ["false"], maxRetries: 3 });
      const now = nowIso();
      const job = ctx.jobs.claimNext({
        workerId: worker.id,
        leaseUntil: addMs(now, 30_000),
        now,
      })!;

      const retry = new RetryService(ctx.jobs, ctx.config);
      retry.handleFailure({
        job,
        error: "boom",
        exitCode: 1,
        stdout: null,
        stderr: "boom",
      });

      const updated = ctx.jobs.getById(created.id)!;
      expect(updated.status).toBe("scheduled");
      expect(updated.workerId).toBeNull();
      expect(new Date(updated.availableAt).getTime()).toBeGreaterThanOrEqual(
        new Date(addMs(now, 1000)).getTime() - 50,
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("moves job to dead when max retries exceeded", () => {
    const ctx = createTestContext();
    try {
      const worker = ctx.workers.register({ hostname: "t", pid: 1 });
      const created = ctx.jobs.create({ command: ["false"], maxRetries: 0 });
      const now = nowIso();
      const job = ctx.jobs.claimNext({
        workerId: worker.id,
        leaseUntil: addMs(now, 30_000),
        now,
      })!;

      // attempts is 1, maxRetries 0 => 1 > 0 => dead
      const retry = new RetryService(ctx.jobs, ctx.config);
      retry.handleFailure({
        job,
        error: "no retries",
        exitCode: 1,
        stdout: null,
        stderr: null,
      });

      const updated = ctx.jobs.getById(created.id)!;
      expect(updated.status).toBe("dead");
    } finally {
      ctx.cleanup();
    }
  });
});
