import type { Job } from "../models/Job.js";
import { ConfigRepository } from "../repositories/ConfigRepository.js";
import { JobRepository } from "../repositories/JobRepository.js";
import { addMs, nowIso, sleep } from "../utils/time.js";
import { logger } from "../utils/logger.js";
import type { WorkerService } from "./WorkerService.js";
import type { RecoveryService } from "./RecoveryService.js";
import type { RetryService } from "./RetryService.js";
import type { JobExecutor, ExecutionResult } from "./JobExecutor.js";

export interface SchedulerDeps {
  workerId: string;
  workerService: WorkerService;
  jobs: JobRepository;
  config: ConfigRepository;
  recovery: RecoveryService;
  retry: RetryService;
  executor: JobExecutor;
}

/**
 * Poll loop: recovery → heartbeat → claim → execute → retry/complete.
 * Graceful shutdown stops new claims and waits for the in-flight job.
 */
export class Scheduler {
  private stopping = false;
  private currentJobId: string | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: SchedulerDeps) {}

  requestShutdown(reason: string): void {
    if (this.stopping) return;
    this.stopping = true;
    logger.info("Graceful Shutdown Initiated", {
      worker_id: this.deps.workerId,
      reason,
      current_job: this.currentJobId,
    });
  }

  async run(): Promise<void> {
    const { workerId, workerService, config } = this.deps;
    const heartbeatInterval = config.get("heartbeat-interval-ms");
    const pollInterval = config.get("poll-interval-ms");

    this.heartbeatTimer = setInterval(() => {
      this.tickHeartbeat();
    }, heartbeatInterval);

    this.heartbeatTimer.unref?.();

    try {
      while (!this.stopping) {
        if (workerService.shouldStop(workerId)) {
          this.requestShutdown("stop_command");
          break;
        }

        this.deps.recovery.recoverExpiredLeases();
        this.tickHeartbeat();

        const leaseTimeout = config.get("lease-timeout-ms");
        const now = nowIso();
        const job = this.deps.jobs.claimNext({
          workerId,
          leaseUntil: addMs(now, leaseTimeout),
          now,
        });

        if (!job) {
          await sleep(pollInterval);
          continue;
        }

        logger.info("Job Claimed", {
          job_id: job.id,
          worker_id: workerId,
          attempt: job.attempts,
          command: job.command,
        });

        this.currentJobId = job.id;
        await this.executeAndSettle(job);
        this.currentJobId = null;
      }
    } finally {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      workerService.markStopped(workerId);
    }
  }

  private tickHeartbeat(): void {
    const { workerId, workerService, jobs, config } = this.deps;
    workerService.heartbeat(workerId);

    if (this.currentJobId) {
      const leaseUntil = addMs(nowIso(), config.get("lease-timeout-ms"));
      jobs.extendLease(this.currentJobId, leaseUntil);
      logger.debug("Lease Extended", { job_id: this.currentJobId, lease_until: leaseUntil });
    }
  }

  private async executeAndSettle(job: Job): Promise<void> {
    const truncate = this.deps.config.get("output-truncate-bytes");
    let result: ExecutionResult;

    try {
      result = await this.deps.executor.execute(job, { truncateBytes: truncate });
    } catch (error) {
      result = {
        exitCode: 1,
        stdout: "",
        stderr: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (result.exitCode === 0 && !result.error) {
      this.deps.jobs.markCompleted({
        jobId: job.id,
        exitCode: result.exitCode,
        stdout: result.stdout || null,
        stderr: result.stderr || null,
      });
      logger.info("Job Completed", { job_id: job.id, exit_code: result.exitCode });
      return;
    }

    const errorMessage = result.error ?? `exit_code=${result.exitCode}`;
    this.deps.retry.handleFailure({
      job,
      error: errorMessage,
      exitCode: result.exitCode,
      stdout: result.stdout || null,
      stderr: result.stderr || null,
    });
  }
}
