import os from "node:os";
import type { Worker } from "../models/Worker.js";
import { WorkerRepository } from "../repositories/WorkerRepository.js";
import { logger } from "../utils/logger.js";

export class WorkerService {
  constructor(private readonly workers: WorkerRepository) {}

  register(options?: { id?: string }): Worker {
    const worker = this.workers.register({
      ...(options?.id ? { id: options.id } : {}),
      hostname: os.hostname(),
      pid: process.pid,
    });

    logger.info("Worker Started", {
      worker_id: worker.id,
      hostname: worker.hostname,
      pid: worker.pid,
    });

    return worker;
  }

  heartbeat(workerId: string): void {
    this.workers.heartbeat(workerId);
  }

  requestStop(workerId: string): Worker {
    const worker = this.workers.requestStop(workerId);
    logger.info("Worker Stop Requested", { worker_id: worker.id });
    return worker;
  }

  requestStopAll(): Worker[] {
    const workers = this.workers.requestStopAll();
    logger.info("Worker Stop Requested", { count: workers.length, scope: "all" });
    return workers;
  }

  markStopped(workerId: string): Worker {
    const worker = this.workers.markStopped(workerId);
    logger.info("Worker Stopped", { worker_id: worker.id });
    return worker;
  }

  get(workerId: string): Worker | null {
    return this.workers.getById(workerId);
  }

  list(): Worker[] {
    return this.workers.list();
  }

  counts(): Record<string, number> {
    return this.workers.countByStatus();
  }

  shouldStop(workerId: string): boolean {
    const worker = this.workers.getById(workerId);
    return !worker || worker.status === "stopping" || worker.status === "stopped";
  }
}
