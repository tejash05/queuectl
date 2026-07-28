import { describe, expect, it } from "vitest";
import { createTestContext } from "./helpers.js";

describe("JobRepository.list limits", () => {
  it("returns all matching jobs when no limit is provided", () => {
    const ctx = createTestContext();
    try {
      for (let i = 0; i < 60; i += 1) {
        ctx.jobs.create({
          id: `job-${i}`,
          command: `echo ${i}`,
          maxRetries: 3,
        });
      }

      // Mark all completed so list --state completed would match
      for (let i = 0; i < 60; i += 1) {
        ctx.db
          .prepare(`UPDATE jobs SET state = 'completed' WHERE id = ?`)
          .run(`job-${i}`);
      }

      const all = ctx.jobs.list({ state: "completed" });
      expect(all).toHaveLength(60);

      const capped = ctx.jobs.list({ state: "completed", limit: 50 });
      expect(capped).toHaveLength(50);
    } finally {
      ctx.cleanup();
    }
  });
});
