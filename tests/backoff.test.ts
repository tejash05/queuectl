import { describe, expect, it } from "vitest";
import { computeBackoffMs } from "../src/utils/backoff.js";

describe("computeBackoffMs", () => {
  it("uses base delay for first attempt", () => {
    expect(computeBackoffMs(1000, 1)).toBe(1000);
  });

  it("doubles for each subsequent attempt", () => {
    expect(computeBackoffMs(1000, 2)).toBe(2000);
    expect(computeBackoffMs(1000, 3)).toBe(4000);
    expect(computeBackoffMs(1000, 4)).toBe(8000);
  });

  it("rejects invalid inputs", () => {
    expect(() => computeBackoffMs(-1, 1)).toThrow();
    expect(() => computeBackoffMs(1000, 0)).toThrow();
  });
});
