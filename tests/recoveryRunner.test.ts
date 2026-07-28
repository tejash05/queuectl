import { describe, expect, it } from "vitest";
import { RecoveryRunner } from "../src/core/RecoveryRunner.js";
import { RecoveryService } from "../src/core/RecoveryService.js";
import { addMs, nowIso, sleep } from "../src/utils/time.js";
import { createTestContext } from "./helpers.js";

describe("RecoveryRunner (independent recovery timer)", () => {
  it("recovers an expired lease on its own timer, with no scheduler loop running", async () => {
    const ctx = createTestContext();
    try {
      ctx.config.set("recovery-interval-ms", 100);

      const worker = ctx.workers.register({ hostname: "crashed", pid: 4242 });
      ctx.jobs.create({ id: "orphan", command: "echo hi", maxRetries: 3 });
      ctx.jobs.claimNext({
        workerId: worker.id,
        leaseUntil: addMs(nowIso(), -1_000), // already expired: worker died
        now: nowIso(),
      });
      expect(ctx.jobs.getById("orphan")!.state).toBe("processing");

      const runner = new RecoveryRunner(
        new RecoveryService(ctx.jobs, ctx.workers, ctx.config),
        ctx.config,
      );

      // Nothing else drives recovery here — no Scheduler, no poll loop.
      runner.start();
      try {
        await sleep(250);
        const job = ctx.jobs.getById("orphan")!;
        expect(job.state).toBe("pending");
        expect(job.workerId).toBeNull();
        expect(job.leaseUntil).toBeNull();
      } finally {
        runner.stop();
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("recovers immediately on start, so a fresh worker unsticks orphaned jobs", () => {
    const ctx = createTestContext();
    try {
      // Long interval: only the immediate first pass can recover in this test.
      ctx.config.set("recovery-interval-ms", 60_000);

      const worker = ctx.workers.register({ hostname: "crashed", pid: 4243 });
      ctx.jobs.create({ id: "orphan-2", command: "echo hi", maxRetries: 3 });
      ctx.jobs.claimNext({
        workerId: worker.id,
        leaseUntil: addMs(nowIso(), -1_000),
        now: nowIso(),
      });

      const runner = new RecoveryRunner(
        new RecoveryService(ctx.jobs, ctx.workers, ctx.config),
        ctx.config,
      );
      runner.start();
      try {
        expect(ctx.jobs.getById("orphan-2")!.state).toBe("pending");
      } finally {
        runner.stop();
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("stops cleanly and performs no further recovery after stop()", async () => {
    const ctx = createTestContext();
    try {
      ctx.config.set("recovery-interval-ms", 100);

      const runner = new RecoveryRunner(
        new RecoveryService(ctx.jobs, ctx.workers, ctx.config),
        ctx.config,
      );
      runner.start();
      expect(runner.isRunning()).toBe(true);

      runner.stop();
      expect(runner.isRunning()).toBe(false);

      // Create stale work only after stopping; it must survive untouched.
      const worker = ctx.workers.register({ hostname: "crashed", pid: 4244 });
      ctx.jobs.create({ id: "after-stop", command: "echo hi", maxRetries: 3 });
      ctx.jobs.claimNext({
        workerId: worker.id,
        leaseUntil: addMs(nowIso(), -1_000),
        now: nowIso(),
      });

      await sleep(250);
      expect(ctx.jobs.getById("after-stop")!.state).toBe("processing");
    } finally {
      ctx.cleanup();
    }
  });

  it("is idempotent: repeated start() keeps a single timer", () => {
    const ctx = createTestContext();
    try {
      const runner = new RecoveryRunner(
        new RecoveryService(ctx.jobs, ctx.workers, ctx.config),
        ctx.config,
      );
      runner.start();
      runner.start();
      expect(runner.isRunning()).toBe(true);
      runner.stop();
      expect(runner.isRunning()).toBe(false);
      runner.stop();
      expect(runner.isRunning()).toBe(false);
    } finally {
      ctx.cleanup();
    }
  });

  it("survives a recovery error without stopping the timer", async () => {
    const ctx = createTestContext();
    try {
      ctx.config.set("recovery-interval-ms", 100);

      const recovery = new RecoveryService(ctx.jobs, ctx.workers, ctx.config);
      let calls = 0;
      const original = recovery.recover.bind(recovery);
      recovery.recover = () => {
        calls += 1;
        if (calls === 1) throw new Error("simulated SQLITE_BUSY");
        return original();
      };

      const runner = new RecoveryRunner(recovery, ctx.config);
      runner.start(); // first tick throws and is swallowed
      try {
        await sleep(250);
        expect(calls).toBeGreaterThan(1);
        expect(runner.isRunning()).toBe(true);
      } finally {
        runner.stop();
      }
    } finally {
      ctx.cleanup();
    }
  });
});
