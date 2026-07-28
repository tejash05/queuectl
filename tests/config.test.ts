import { describe, expect, it } from "vitest";
import { createTestContext } from "./helpers.js";

describe("ConfigRepository validation", () => {
  it("rejects a fractional max-retries instead of poisoning later enqueues", () => {
    const ctx = createTestContext();
    try {
      expect(() => ctx.config.set("max-retries", 2.5)).toThrow(/integer/);
      expect(ctx.config.get("max-retries")).toBe(3);
    } finally {
      ctx.cleanup();
    }
  });

  it("rejects negative retries and a backoff base below 1", () => {
    const ctx = createTestContext();
    try {
      expect(() => ctx.config.set("max-retries", -1)).toThrow(/between/);
      expect(() => ctx.config.set("backoff-base", 0)).toThrow(/between/);
      expect(() => ctx.config.set("backoff-base", -2)).toThrow(/between/);
    } finally {
      ctx.cleanup();
    }
  });

  it("rejects a lease shorter than 2x the heartbeat so live jobs are not stolen", () => {
    const ctx = createTestContext();
    try {
      expect(() => ctx.config.set("lease-timeout-ms", 0)).toThrow();
      expect(() => ctx.config.set("lease-timeout-ms", 4_000)).toThrow(/2x/);
      ctx.config.set("heartbeat-interval-ms", 1_000);
      ctx.config.set("lease-timeout-ms", 3_000);
      expect(ctx.config.get("lease-timeout-ms")).toBe(3_000);
    } finally {
      ctx.cleanup();
    }
  });
});
