import { describe, expect, it } from "vitest";
import { computeBackoffMs, computeBackoffSeconds } from "../src/utils/backoff.js";

describe("computeBackoffSeconds", () => {
  it("uses base^attempts (assignment contract)", () => {
    expect(computeBackoffSeconds(2, 1)).toBe(2);
    expect(computeBackoffSeconds(2, 2)).toBe(4);
    expect(computeBackoffSeconds(2, 3)).toBe(8);
  });

  it("converts to milliseconds", () => {
    expect(computeBackoffMs(2, 1)).toBe(2000);
    expect(computeBackoffMs(2, 2)).toBe(4000);
    expect(computeBackoffMs(2, 3)).toBe(8000);
  });

  it("rejects invalid inputs", () => {
    expect(() => computeBackoffSeconds(-1, 1)).toThrow();
    expect(() => computeBackoffSeconds(2, 0)).toThrow();
  });
});
