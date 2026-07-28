import { ConfigRepository } from "../repositories/ConfigRepository.js";
import { JobRepository } from "../repositories/JobRepository.js";
import { WorkerRepository } from "../repositories/WorkerRepository.js";
import { addMs, nowIso } from "../utils/time.js";
import { logger } from "../utils/logger.js";

export class RecoveryService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly workers: WorkerRepository,
    private readonly config: ConfigRepository,
  ) {}

  /**
   * Job crash recovery: expired leases → pending.
   * Independent of worker row status (leases are the source of truth for jobs).
   */
  recoverExpiredLeases(): number {
    const recovered = this.jobs.recoverExpiredLeases(nowIso());
    if (recovered.length > 0) {
      logger.warn("Recovery Executed", {
        count: recovered.length,
        job_ids: recovered.map((j) => j.id).join(","),
      });
    }
    return recovered.length;
  }

  /**
   * Worker liveness cleanup: stale heartbeats → stopped.
   * Display/ops fix for zombies left behind by SIGKILL; does not reclaim jobs.
   */
  recoverStaleWorkers(): number {
    const now = nowIso();
    const staleMs = Math.max(
      this.config.get("lease-timeout-ms"),
      this.config.get("heartbeat-interval-ms") * 3,
    );
    const staleBefore = addMs(now, -staleMs);
    const marked = this.workers.markStaleAsStopped(staleBefore, now);

    if (marked.length > 0) {
      logger.warn("Stale Workers Marked Stopped", {
        count: marked.length,
        worker_ids: marked.map((w) => w.id).join(","),
        stale_before: staleBefore,
      });
    }
    return marked.length;
  }

  /** Run both job lease recovery and stale worker cleanup. */
  recover(): { jobs: number; workers: number } {
    return {
      jobs: this.recoverExpiredLeases(),
      workers: this.recoverStaleWorkers(),
    };
  }
}
