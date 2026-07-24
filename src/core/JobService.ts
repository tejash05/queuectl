import { toJobJson, type Job, type JobJson } from "../models/Job.js";
import { ConfigRepository } from "../repositories/ConfigRepository.js";
import { JobRepository } from "../repositories/JobRepository.js";
import type { JobState } from "../types/status.js";
import { createId } from "../utils/id.js";
import { logger } from "../utils/logger.js";

export interface EnqueuePayload {
  id?: string;
  command: string;
  max_retries?: number;
}

export class JobService {
  constructor(
    private readonly jobs: JobRepository,
    private readonly config: ConfigRepository,
  ) {}

  enqueueFromJson(raw: string): Job {
    let payload: EnqueuePayload;
    try {
      payload = JSON.parse(raw) as EnqueuePayload;
    } catch {
      throw new Error(
        `Invalid JSON. Usage: queuectl enqueue '{"id":"job1","command":"echo hello"}'`,
      );
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Enqueue payload must be a JSON object");
    }

    if (typeof payload.command !== "string" || payload.command.trim() === "") {
      throw new Error('Enqueue JSON must include a non-empty string "command"');
    }

    if (payload.id !== undefined && (typeof payload.id !== "string" || payload.id.trim() === "")) {
      throw new Error('Enqueue JSON "id" must be a non-empty string when provided');
    }

    const maxRetries =
      typeof payload.max_retries === "number"
        ? payload.max_retries
        : this.config.get("max-retries");

    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new Error("max_retries must be a non-negative integer");
    }

    const job = this.jobs.create({
      id: payload.id?.trim() || createId(),
      command: payload.command,
      maxRetries,
    });

    logger.info("Job Enqueued", {
      job_id: job.id,
      command: job.command,
      max_retries: job.maxRetries,
    });

    return job;
  }

  get(id: string): Job | null {
    return this.jobs.getById(id);
  }

  list(options: { state?: JobState; limit: number }): Job[] {
    return this.jobs.list(options);
  }

  listJson(options: { state?: JobState; limit: number }): JobJson[] {
    return this.list(options).map(toJobJson);
  }

  counts(): Record<string, number> {
    return this.jobs.countByState();
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
