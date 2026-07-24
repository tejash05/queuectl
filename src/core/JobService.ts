import type { Job } from "../models/Job.js";
import { ConfigRepository } from "../repositories/ConfigRepository.js";
import { JobRepository } from "../repositories/JobRepository.js";
import type { JobStatus } from "../types/status.js";
import { logger } from "../utils/logger.js";

export interface EnqueueOptions {
  command: string[];
  cwd?: string;
}

export class JobService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly config: ConfigRepository,
  ) {}

  enqueue(options: EnqueueOptions): Job {
    if (options.command.length === 0) {
      throw new Error("Command is required. Usage: queuectl enqueue -- <command> [args...]");
    }

    const maxRetries = this.config.get("max_retries");
    const job = this.jobs.create({
      command: options.command,
      cwd: options.cwd ?? null,
      maxRetries,
    });

    logger.info("Job Enqueued", {
      job_id: job.id,
      command: job.command.join(" "),
      max_retries: job.maxRetries,
    });

    return job;
  }

  get(id: string): Job | null {
    return this.jobs.getById(id);
  }

  list(options: { status?: JobStatus; limit: number }): Job[] {
    return this.jobs.list(options);
  }

  counts(): Record<string, number> {
    return this.jobs.countByStatus();
  }

  listDead(limit: number): Job[] {
    return this.jobs.listDead(limit);
  }

  retryDead(jobId: string): Job {
    const job = this.jobs.requeueDead(jobId);
    if (!job) {
      throw new Error(`Dead job not found: ${jobId}`);
    }
    logger.info("DLQ Retry", { job_id: job.id });
    return job;
  }

  retryAllDead(): number {
    const count = this.jobs.requeueAllDead();
    logger.info("DLQ Retry All", { count });
    return count;
  }
}
