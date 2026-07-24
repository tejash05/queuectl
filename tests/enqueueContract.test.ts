import { describe, expect, it } from "vitest";
import { JobService } from "../src/core/JobService.js";
import { toJobJson } from "../src/models/Job.js";
import { createTestContext } from "./helpers.js";

describe("enqueue JSON contract", () => {
  it("parses assignment JSON and preserves id/command/state", () => {
    const ctx = createTestContext();
    try {
      const service = new JobService(ctx.jobs, ctx.config);
      const job = service.enqueueFromJson(
        '{"id":"job1","command":"echo Hello QueueCTL"}',
      );

      expect(toJobJson(job)).toEqual({
        id: "job1",
        command: "echo Hello QueueCTL",
        state: "pending",
        attempts: 0,
        max_retries: 3,
      });
    } finally {
      ctx.cleanup();
    }
  });
});
