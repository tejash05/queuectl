import { describe, expect, it } from "vitest";
import { RetryService } from "../src/core/RetryService.js";
import { addMs, nowIso } from "../src/utils/time.js";
import { createTestContext } from "./helpers.js";

describe("RetryService", () => {
  it("marks a retryable failure as failed with a base^attempts backoff", () => {
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
      // Assignment definition: failed = failed, but will be retried.
      expect(updated.state).toBe("failed");
      expect(updated.workerId).toBeNull();
      expect(updated.lastError).toBe("boom");
      // attempts=1 → 2^1 = 2 seconds
      expect(new Date(updated.availableAt).getTime()).toBeGreaterThanOrEqual(
        new Date(addMs(now, 2000)).getTime() - 50,
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("hides a failed job until its backoff expires, then allows re-claim", () => {
    const ctx = createTestContext();
    try {
      ctx.config.set("backoff-base", 2);
      const worker = ctx.workers.register({ hostname: "t", pid: 1 });
      ctx.jobs.create({ id: "backoff-gate", command: "false", maxRetries: 3 });
      const now = nowIso();
      const job = ctx.jobs.claimNext({
        workerId: worker.id,
        leaseUntil: addMs(now, 30_000),
        now,
      })!;

      new RetryService(ctx.jobs, ctx.config).handleFailure({
        job,
        error: "boom",
        exitCode: 1,
        stdout: null,
        stderr: null,
      });

      // Inside the backoff window the job must not be runnable.
      expect(
        ctx.jobs.claimNext({
          workerId: worker.id,
          leaseUntil: addMs(nowIso(), 30_000),
          now: nowIso(),
        }),
      ).toBeNull();

      // Once available_at has passed, the same failed job is claimable again.
      const afterBackoff = addMs(nowIso(), 3_000);
      const reclaimed = ctx.jobs.claimNext({
        workerId: worker.id,
        leaseUntil: addMs(afterBackoff, 30_000),
        now: afterBackoff,
      });

      expect(reclaimed?.id).toBe("backoff-gate");
      expect(reclaimed?.state).toBe("processing");
      expect(reclaimed?.attempts).toBe(2);
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
