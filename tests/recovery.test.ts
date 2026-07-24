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

      const recovery = new RecoveryService(ctx.jobs);
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

      const recovery = new RecoveryService(ctx.jobs);
      expect(recovery.recoverExpiredLeases()).toBe(0);
    } finally {
      ctx.cleanup();
    }
  });
});
