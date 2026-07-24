import { describe, expect, it } from "vitest";
import { WorkerService } from "../src/core/WorkerService.js";
import { createTestContext } from "./helpers.js";

describe("worker stop cooperation", () => {
  it("marks all active workers as stopping via worker stop", () => {
    const ctx = createTestContext();
    try {
      const service = new WorkerService(ctx.workers);
      const w1 = service.register();
      const w2 = service.register();
      expect(w1.status).toBe("active");
      expect(w2.status).toBe("active");

      const stopping = service.requestStopAll();
      expect(stopping).toHaveLength(2);
      expect(service.shouldStop(w1.id)).toBe(true);
      expect(service.shouldStop(w2.id)).toBe(true);
    } finally {
      ctx.cleanup();
    }
  });
});
