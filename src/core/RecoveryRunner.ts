import type { ConfigRepository } from "../repositories/ConfigRepository.js";
import type { RecoveryService } from "./RecoveryService.js";
import { logger } from "../utils/logger.js";

/**
 * Timer-driven lease recovery, owned by the worker process rather than by any
 * individual Scheduler.
 *
 * A Scheduler awaits its own job inside its poll loop, so recovery that lives in
 * that loop cannot run while the worker is executing a long command. Crashed
 * peers would then stay unrecovered for the length of someone else's job. This
 * runner uses setInterval instead: job execution is async I/O (child process
 * events), so the event loop stays free and the timer keeps firing throughout.
 *
 * Safety comes from the store, not from this class: RecoveryService delegates to
 * JobRepository.recoverExpiredLeases(), whose write runs under BEGIN IMMEDIATE.
 * Concurrent runners in other processes serialize on SQLite's write lock, and a
 * runner that loses the race re-reads no stale rows, so recovery is never
 * applied twice.
 */
export class RecoveryRunner {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly recovery: RecoveryService,
    private readonly config: ConfigRepository,
  ) {}

  start(): void {
    if (this.timer) return;

    const intervalMs = this.config.get("recovery-interval-ms");

    // Immediate first pass: a freshly started worker reclaims jobs orphaned
    // while no worker was alive at all.
    this.tick();

    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();

    logger.debug("Recovery Loop Started", { interval_ms: intervalMs });
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    logger.debug("Recovery Loop Stopped");
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  /** One recovery pass. Synchronous, so passes can never overlap. */
  tick(): void {
    try {
      this.recovery.recover();
    } catch (error) {
      // A transient lock error must not kill the timer or take down the worker:
      // an uncaught throw in a timer callback would crash the process.
      logger.warn("Recovery Loop Error", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
