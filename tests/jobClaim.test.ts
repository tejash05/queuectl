import { describe, expect, it } from "vitest";
import { addMs, nowIso } from "../src/utils/time.js";
import { createTestContext } from "./helpers.js";

describe("atomic job claiming", () => {
  it("claims the oldest available job", () => {
    const ctx = createTestContext();
    try {
      const first = ctx.jobs.create({ command: ["echo", "one"], maxRetries: 3 });
      ctx.jobs.create({ command: ["echo", "two"], maxRetries: 3 });

      const worker = ctx.workers.register({ hostname: "test", pid: 1 });
      const now = nowIso();
      const claimed = ctx.jobs.claimNext({
        workerId: worker.id,
        leaseUntil: addMs(now, 30_000),
        now,
      });

      expect(claimed?.id).toBe(first.id);
      expect(claimed?.status).toBe("running");
      expect(claimed?.attempts).toBe(1);
      expect(claimed?.workerId).toBe(worker.id);
    } finally {
      ctx.cleanup();
    }
  });

  it("does not allow two workers to claim the same job", () => {
    const ctx = createTestContext();
    try {
      ctx.jobs.create({ command: ["echo", "only"], maxRetries: 3 });
      const w1 = ctx.workers.register({ hostname: "a", pid: 1 });
      const w2 = ctx.workers.register({ hostname: "b", pid: 2 });
      const now = nowIso();

      const c1 = ctx.jobs.claimNext({
        workerId: w1.id,
        leaseUntil: addMs(now, 30_000),
        now,
      });
      const c2 = ctx.jobs.claimNext({
        workerId: w2.id,
        leaseUntil: addMs(now, 30_000),
        now,
      });

      expect(c1).not.toBeNull();
      expect(c2).toBeNull();
    } finally {
      ctx.cleanup();
    }
  });

  it("skips scheduled jobs that are not yet available", () => {
    const ctx = createTestContext();
    try {
      const job = ctx.jobs.create({ command: ["echo", "later"], maxRetries: 3 });
      const future = addMs(nowIso(), 60_000);
      ctx.db
        .prepare(`UPDATE jobs SET status = 'scheduled', available_at = ? WHERE id = ?`)
        .run(future, job.id);

      const worker = ctx.workers.register({ hostname: "test", pid: 1 });
      const claimed = ctx.jobs.claimNext({
        workerId: worker.id,
        leaseUntil: addMs(nowIso(), 30_000),
        now: nowIso(),
      });

      expect(claimed).toBeNull();
    } finally {
      ctx.cleanup();
    }
  });
});
