/**
 * Exponential backoff: baseMs * 2^(attempt - 1)
 * attempt is 1-based (first failure => attempt 1 => baseMs).
 */
export function computeBackoffMs(baseMs: number, attempt: number): number {
  if (baseMs < 0) {
    throw new Error("baseMs must be non-negative");
  }
  if (attempt < 1) {
    throw new Error("attempt must be >= 1");
  }

  const exp = attempt - 1;
  const delay = baseMs * 2 ** exp;

  // Guard against overflow for pathological configs
  return Math.min(delay, Number.MAX_SAFE_INTEGER);
}
