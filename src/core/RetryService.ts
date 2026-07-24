import type { Job } from "../models/Job.js";
import { ConfigRepository } from "../repositories/ConfigRepository.js";
import { JobRepository } from "../repositories/JobRepository.js";
import { computeBackoffMs } from "../utils/backoff.js";
import { addMs, nowIso } from "../utils/time.js";
import { logger } from "../utils/logger.js";

export interface HandleFailureInput {
  job: Job;
  error: string;
  exitCode: number | null;
  stdout: string | null;
  stderr: string | null;
}

export class RetryService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly config: ConfigRepository,
  ) {}

  handleFailure(input: HandleFailureInput): void {
    const { job, error, exitCode, stdout, stderr } = input;

    // attempts was incremented at claim time
    if (job.attempts > job.maxRetries) {
      this.jobs.markDead({
        jobId: job.id,
        error,
        exitCode,
        stdout,
        stderr,
      });
      logger.error("Job Dead", {
        job_id: job.id,
        attempts: job.attempts,
        max_retries: job.maxRetries,
        error,
      });
      return;
    }

    const base = this.config.get("backoff-base");
    const delayMs = computeBackoffMs(base, job.attempts);
    const availableAt = addMs(nowIso(), delayMs);

    this.jobs.scheduleRetry({
      jobId: job.id,
      availableAt,
      error,
      exitCode,
      stdout,
      stderr,
    });

    logger.warn("Retry Scheduled", {
      job_id: job.id,
      attempt: job.attempts,
      delay_seconds: delayMs / 1000,
      available_at: availableAt,
      error,
    });
  }
}
