import { describe, expect, it } from "vitest";
import { JobExecutor } from "../src/core/JobExecutor.js";
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

  it("recovers a crashed worker's job, then another worker reclaims and completes it", async () => {
    const ctx = createTestContext();
    try {
      const crashed = ctx.workers.register({ hostname: "crashed-host", pid: 111 });
      const survivor = ctx.workers.register({ hostname: "survivor-host", pid: 222 });
      ctx.jobs.create({ id: "sleep3", command: "echo recovered-ok", maxRetries: 3 });

      // 1) Worker A claims job and writes a lease (simulates in-flight work).
      const claimNow = nowIso();
      const leaseUntil = addMs(claimNow, 30_000);
      const claimed = ctx.jobs.claimNext({
        workerId: crashed.id,
        leaseUntil,
        now: claimNow,
      });

      expect(claimed).not.toBeNull();
      expect(claimed!.state).toBe("processing");
      expect(claimed!.workerId).toBe(crashed.id);
      expect(claimed!.attempts).toBe(1);
      expect(claimed!.leaseUntil).toBe(leaseUntil);

      // 2) Worker A receives SIGKILL — no cleanup; force lease expiry.
      const expiredLease = addMs(nowIso(), -1_000);
      ctx.db
        .prepare(`UPDATE jobs SET lease_until = ? WHERE id = ?`)
        .run(expiredLease, "sleep3");
      expect(ctx.jobs.getById("sleep3")!.state).toBe("processing");

      // 3) RecoveryService detects expired lease and resets to pending.
      const recovery = new RecoveryService(ctx.jobs, ctx.workers, ctx.config);
      const recoveredCount = recovery.recoverExpiredLeases();
      expect(recoveredCount).toBe(1);

      const recovered = ctx.jobs.getById("sleep3")!;
      expect(recovered.state).toBe("pending");
      expect(recovered.workerId).toBeNull();
      expect(recovered.leaseUntil).toBeNull();
      expect(recovered.attempts).toBe(1); // attempts preserved across crash recovery

      // 4) Survivor worker atomically claims the recovered job.
      const reclaimNow = nowIso();
      const newLease = addMs(reclaimNow, 30_000);
      const reclaimed = ctx.jobs.claimNext({
        workerId: survivor.id,
        leaseUntil: newLease,
        now: reclaimNow,
      });

      expect(reclaimed).not.toBeNull();
      expect(reclaimed!.id).toBe("sleep3");
      expect(reclaimed!.state).toBe("processing");
      expect(reclaimed!.workerId).toBe(survivor.id);
      expect(reclaimed!.attempts).toBe(2);
      expect(reclaimed!.leaseUntil).toBe(newLease);

      // Crashed worker must not be able to claim it again.
      expect(
        ctx.jobs.claimNext({
          workerId: crashed.id,
          leaseUntil: addMs(nowIso(), 30_000),
          now: nowIso(),
        }),
      ).toBeNull();

      // 5) Survivor executes and completes successfully.
      const executor = new JobExecutor();
      const result = await executor.execute(reclaimed!, { truncateBytes: 1024 });
      expect(result.exitCode).toBe(0);

      ctx.jobs.markCompleted({
        jobId: reclaimed!.id,
        exitCode: result.exitCode,
        stdout: result.stdout || null,
        stderr: result.stderr || null,
      });

      const completed = ctx.jobs.getById("sleep3")!;
      expect(completed.state).toBe("completed");
      expect(completed.exitCode).toBe(0);
      expect(completed.workerId).toBe(survivor.id);
      expect(completed.attempts).toBe(2);
    } finally {
      ctx.cleanup();
    }
  });
});
