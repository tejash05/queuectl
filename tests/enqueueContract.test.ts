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
        created_at: job.createdAt,
        updated_at: job.updatedAt,
      });
    } finally {
      ctx.cleanup();
    }
  });

  it("exposes all seven required fields with ISO timestamps", () => {
    const ctx = createTestContext();
    try {
      const service = new JobService(ctx.jobs, ctx.config);
      const json = toJobJson(service.enqueueFromJson('{"command":"echo hi"}'));

      expect(Object.keys(json).sort()).toEqual([
        "attempts",
        "command",
        "created_at",
        "id",
        "max_retries",
        "state",
        "updated_at",
      ]);
      expect(Number.isNaN(Date.parse(json.created_at))).toBe(false);
      expect(Number.isNaN(Date.parse(json.updated_at))).toBe(false);
    } finally {
      ctx.cleanup();
    }
  });
});
