import { describe, expect, it } from "vitest";
import { WorkerService } from "../src/core/WorkerService.js";
import { createTestContext } from "./helpers.js";

describe("worker stop cooperation", () => {
  it("marks worker as stopping via stop command", () => {
    const ctx = createTestContext();
    try {
      const service = new WorkerService(ctx.workers);
      const worker = service.register();
      expect(worker.status).toBe("active");

      const stopping = service.requestStop(worker.id);
      expect(stopping.status).toBe("stopping");
      expect(service.shouldStop(worker.id)).toBe(true);

      const stopped = service.markStopped(worker.id);
      expect(stopped.status).toBe("stopped");
      expect(stopped.stoppedAt).not.toBeNull();
    } finally {
      ctx.cleanup();
    }
  });
});
