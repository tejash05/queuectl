/**
 * Assignment backoff: delay_seconds = base ^ attempts
 *
 * Example with base=2:
 *   attempts=1 → 2s
 *   attempts=2 → 4s
 *   attempts=3 → 8s
 */
export function computeBackoffSeconds(base: number, attempts: number): number {
  if (base < 0) {
    throw new Error("backoff base must be non-negative");
  }
  if (attempts < 1) {
    throw new Error("attempts must be >= 1");
  }

  const seconds = base ** attempts;
  if (!Number.isFinite(seconds) || seconds > Number.MAX_SAFE_INTEGER) {
    return Number.MAX_SAFE_INTEGER;
  }
  return seconds;
}

export function computeBackoffMs(base: number, attempts: number): number {
  return computeBackoffSeconds(base, attempts) * 1000;
}
