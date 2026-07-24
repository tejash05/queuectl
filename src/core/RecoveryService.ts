import { JobRepository } from "../repositories/JobRepository.js";
import { nowIso } from "../utils/time.js";
import { logger } from "../utils/logger.js";

export class RecoveryService {
  constructor(private readonly jobs: JobRepository) {}

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
}
