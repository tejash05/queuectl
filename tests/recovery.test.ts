import { describe, expect, it } from "vitest";
import { RecoveryService } from "../src/core/RecoveryService.js";
import { addMs, nowIso } from "../src/utils/time.js";
import { createTestContext } from "./helpers.js";

describe("RecoveryService", () => {
  it("requeues processing jobs with expired leases to pending", () => {
    const ctx = createTestContext();
    try {
      const worker = ctx.workers.register({ hostname: "t", pid: 1 });
      const created = ctx.jobs.create({ id: "lease-job", command: "sleep 10", maxRetries: 3 });
      const past = addMs(nowIso(), -60_000);
      const job = ctx.jobs.claimNext({
        workerId: worker.id,
        leaseUntil: past,
        now: nowIso(),
      })!;

      ctx.db.prepare(`UPDATE jobs SET lease_until = ? WHERE id = ?`).run(past, job.id);

      const recovery = new RecoveryService(ctx.jobs, ctx.workers, ctx.config);
      const count = recovery.recoverExpiredLeases();

      expect(count).toBe(1);
      const updated = ctx.jobs.getById(created.id)!;
      expect(updated.state).toBe("pending");
      expect(updated.workerId).toBeNull();
      expect(updated.leaseUntil).toBeNull();
    } finally {
      ctx.cleanup();
    }
  });

  it("does not recover jobs with valid leases", () => {
    const ctx = createTestContext();
    try {
      const worker = ctx.workers.register({ hostname: "t", pid: 1 });
      ctx.jobs.create({ id: "ok-lease", command: "sleep 10", maxRetries: 3 });
      const now = nowIso();
      ctx.jobs.claimNext({
        workerId: worker.id,
        leaseUntil: addMs(now, 30_000),
        now,
      });

      const recovery = new RecoveryService(ctx.jobs, ctx.workers, ctx.config);
      expect(recovery.recoverExpiredLeases()).toBe(0);
    } finally {
      ctx.cleanup();
    }
  });

  it("marks workers with expired heartbeats as stopped (zombie cleanup)", () => {
    const ctx = createTestContext();
    try {
      ctx.config.set("lease-timeout-ms", 30_000);
      ctx.config.set("heartbeat-interval-ms", 5_000);

      const zombie = ctx.workers.register({ hostname: "dead-host", pid: 99999 });
      const live = ctx.workers.register({ hostname: "live-host", pid: 1 });

      // Simulate SIGKILL days ago: heartbeat frozen, status still active
      const daysAgo = addMs(nowIso(), -3 * 24 * 60 * 60 * 1000);
      ctx.db
        .prepare(`UPDATE workers SET last_heartbeat_at = ? WHERE id = ?`)
        .run(daysAgo, zombie.id);

      const recovery = new RecoveryService(ctx.jobs, ctx.workers, ctx.config);
      const marked = recovery.recoverStaleWorkers();

      expect(marked).toBe(1);
      expect(ctx.workers.getById(zombie.id)?.status).toBe("stopped");
      expect(ctx.workers.getById(zombie.id)?.stoppedAt).not.toBeNull();
      // Fresh heartbeat must remain active
      expect(ctx.workers.getById(live.id)?.status).toBe("active");
    } finally {
      ctx.cleanup();
    }
  });

  it("does not mark workers with recent heartbeats as stopped", () => {
    const ctx = createTestContext();
    try {
      const worker = ctx.workers.register({ hostname: "fresh", pid: 1 });
      const recovery = new RecoveryService(ctx.jobs, ctx.workers, ctx.config);

      expect(recovery.recoverStaleWorkers()).toBe(0);
      expect(ctx.workers.getById(worker.id)?.status).toBe("active");
    } finally {
      ctx.cleanup();
    }
  });
});
