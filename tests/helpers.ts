import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDatabase, openDatabase, type SqliteDatabase } from "../src/database/database.js";
import { ConfigRepository } from "../src/repositories/ConfigRepository.js";
import { JobRepository } from "../src/repositories/JobRepository.js";
import { WorkerRepository } from "../src/repositories/WorkerRepository.js";

export interface TestContext {
  db: SqliteDatabase;
  dbPath: string;
  jobs: JobRepository;
  workers: WorkerRepository;
  config: ConfigRepository;
  cleanup: () => void;
}

export function createTestContext(): TestContext {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuectl-"));
  const dbPath = path.join(dir, "test.sqlite");
  const db = openDatabase(dbPath);

  return {
    db,
    dbPath,
    jobs: new JobRepository(db),
    workers: new WorkerRepository(db),
    config: new ConfigRepository(db),
    cleanup: () => {
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
