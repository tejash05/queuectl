import { describe, expect, it } from "vitest";
import { RetryService } from "../src/core/RetryService.js";
import { addMs, nowIso } from "../src/utils/time.js";
import { createTestContext } from "./helpers.js";

describe("RetryService", () => {
  it("schedules retry with base^attempts delay while remaining pending", () => {
    const ctx = createTestContext();
    try {
      ctx.config.set("backoff-base", 2);
      const worker = ctx.workers.register({ hostname: "t", pid: 1 });
      const created = ctx.jobs.create({ id: "retry-me", command: "false", maxRetries: 3 });
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
      expect(updated.state).toBe("pending");
      expect(updated.workerId).toBeNull();
      // attempts=1 → 2^1 = 2 seconds
      expect(new Date(updated.availableAt).getTime()).toBeGreaterThanOrEqual(
        new Date(addMs(now, 2000)).getTime() - 50,
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("moves job to dead when max retries exceeded", () => {
    const ctx = createTestContext();
    try {
      const worker = ctx.workers.register({ hostname: "t", pid: 1 });
      const created = ctx.jobs.create({ id: "dead-me", command: "false", maxRetries: 0 });
      const now = nowIso();
      const job = ctx.jobs.claimNext({
        workerId: worker.id,
        leaseUntil: addMs(now, 30_000),
        now,
      })!;

      const retry = new RetryService(ctx.jobs, ctx.config);
      retry.handleFailure({
        job,
        error: "no retries",
        exitCode: 1,
        stdout: null,
        stderr: null,
      });

      const updated = ctx.jobs.getById(created.id)!;
      expect(updated.state).toBe("dead");
    } finally {
      ctx.cleanup();
    }
  });
});
