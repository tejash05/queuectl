import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, openDatabase, type SqliteDatabase } from "../src/database/database.js";
import { ConfigRepository } from "../src/repositories/ConfigRepository.js";
import { JobRepository } from "../src/repositories/JobRepository.js";
import { WorkerRepository } from "../src/repositories/WorkerRepository.js";
import { sleep } from "../src/utils/time.js";

/**
 * End-to-end crash rule test with real OS processes.
 *
 * The case this exists for: worker B is SIGKILLed while worker A is busy with a
 * long command. Recovery used to live only in the scheduler poll loop, which is
 * blocked for the duration of A's job, so B's job stayed 'processing' until A
 * finished. RecoveryRunner's timer must reclaim it while A is still busy.
 *
 * The assignment crash rule is: never stuck in processing; recover so the job
 * can run again within 60s at defaults. After SIGKILL that is at-least-once
 * (the detached child may finish while recovery re-executes). Exactly-once is
 * scenario 3 (live competing workers), not crash recovery.
 *
 * Timings are compressed via config so the test runs in ~25s instead of ~45s;
 * the mechanism under test is identical at default settings.
 */
const LEASE_TIMEOUT_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 1_000;
const RECOVERY_INTERVAL_MS = 1_000;
const POLL_INTERVAL_MS = 300;

/** lease residual (<= lease timeout) + one recovery interval + scheduling slack. */
const EXPECTED_RECOVERY_CEILING_MS = LEASE_TIMEOUT_MS + RECOVERY_INTERVAL_MS + 4_000;

const LONG_JOB_SECONDS = 12;
const VICTIM_JOB_SECONDS = 4;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const cliEntry = path.join(repoRoot, "src", "index.ts");

interface WorkerProcess {
  child: ChildProcess;
  stderr: string;
}

const spawned: WorkerProcess[] = [];
let tempDir: string | null = null;
let db: SqliteDatabase | null = null;

/** Own process group per worker process. Job children are spawned `detached`,
 *  so SIGKILL of this group kills the worker, not the in-flight shell command. */
function startWorker(dbPath: string): WorkerProcess {
  const child = spawn(tsxBin, [cliEntry, "worker", "start"], {
    cwd: repoRoot,
    env: { ...process.env, QUEUECTL_DB: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  const record: WorkerProcess = { child, stderr: "" };
  child.stderr?.on("data", (chunk: Buffer) => {
    record.stderr += chunk.toString("utf8");
  });
  child.stdout?.resume();

  spawned.push(record);
  return record;
}

function killGroup(worker: WorkerProcess, signal: NodeJS.Signals = "SIGKILL"): void {
  const pid = worker.child.pid;
  if (pid === undefined || worker.child.exitCode !== null) return;
  try {
    // Negative pid targets the worker process group (tsx + node). The job
    // command is spawned detached, so this does not reap it — crash recovery
    // is at-least-once, matching the assignment crash rule.
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

async function waitFor<T>(
  probe: () => T | null | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await sleep(50);
  }
}

afterEach(() => {
  for (const worker of spawned) {
    killGroup(worker);
  }
  spawned.length = 0;

  if (db) {
    closeDatabase(db);
    db = null;
  }
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("crash rule: SIGKILLed worker's job recovers while a peer is busy", () => {
  it(
    "recovers the orphaned job before the busy worker's long job finishes (at-least-once)",
    async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "queuectl-e2e-"));
      const dbPath = path.join(tempDir, "queue.sqlite");
      const markerPath = path.join(tempDir, "side-effect.txt");

      db = openDatabase(dbPath);
      const jobs = new JobRepository(db);
      const workers = new WorkerRepository(db);
      const config = new ConfigRepository(db);

      config.set("heartbeat-interval-ms", HEARTBEAT_INTERVAL_MS);
      config.set("lease-timeout-ms", LEASE_TIMEOUT_MS);
      config.set("recovery-interval-ms", RECOVERY_INTERVAL_MS);
      config.set("poll-interval-ms", POLL_INTERVAL_MS);

      // 1) Long job first, and wait for worker A to own it before enqueueing the
      //    victim, so job->worker assignment is deterministic.
      jobs.create({
        id: "long-job",
        command: `sleep ${LONG_JOB_SECONDS}`,
        maxRetries: 3,
      });

      const workerA = startWorker(dbPath);
      await waitFor(
        () => jobs.getById("long-job")?.state === "processing",
        20_000,
        "worker A to claim long-job",
      );
      const longJobClaimedAt = Date.now();

      // 2) Victim job: echo runs after the sleep. SIGKILL of the worker does
      //    not reap the detached child, so that echo may still land; recovery
      //    then runs the command again (at-least-once).
      jobs.create({
        id: "victim-job",
        command: `sleep ${VICTIM_JOB_SECONDS} && echo done >> '${markerPath}'`,
        maxRetries: 3,
      });

      const workerB = startWorker(dbPath);
      await waitFor(
        () => jobs.getById("victim-job")?.state === "processing",
        20_000,
        "worker B to claim victim-job",
      );

      // 3) Confirm two distinct worker rows in two distinct OS processes.
      const longOwner = workers.getById(jobs.getById("long-job")!.workerId!)!;
      const victimOwner = workers.getById(jobs.getById("victim-job")!.workerId!)!;
      expect(victimOwner.id).not.toBe(longOwner.id);
      expect(victimOwner.pid).not.toBe(longOwner.pid);

      // 4) SIGKILL worker B mid-job. No handler runs, no lease is released.
      const killedAt = Date.now();
      killGroup(workerB);
      expect(jobs.getById("victim-job")!.state).toBe("processing");

      // 5) Recovery must happen while A is still executing its long command.
      //    Key on the durable job_history row, not on the 'pending' state: a
      //    free worker can re-claim within the same synchronous tick, making
      //    'pending' unobservable. The audit event is permanent.
      const countRecoveredEvents = (): number =>
        (
          db!
            .prepare(
              `SELECT COUNT(*) AS n FROM job_history WHERE job_id = ? AND event = 'recovered'`,
            )
            .get("victim-job") as { n: number }
        ).n;

      let longJobStateAtRecovery = "";
      let victimStateAtRecovery = "";
      await waitFor(() => {
        if (countRecoveredEvents() === 0) return false;
        longJobStateAtRecovery = jobs.getById("long-job")!.state;
        victimStateAtRecovery = jobs.getById("victim-job")!.state;
        return true;
      }, 30_000, "victim-job lease recovery to be recorded");

      const recoveryMs = Date.now() - killedAt;
      const longJobElapsedMs = Date.now() - longJobClaimedAt;

      // The assertion this test exists for: the peer was still mid-execution.
      expect(longJobStateAtRecovery).toBe("processing");
      expect(longJobElapsedMs).toBeLessThan(LONG_JOB_SECONDS * 1000);

      // Worker A is busy, so the recovered job waits in pending rather than
      // being re-claimed instantly.
      expect(victimStateAtRecovery).toBe("pending");

      const recovered = jobs.getById("victim-job")!;
      expect(recovered.workerId).toBeNull();
      expect(recovered.leaseUntil).toBeNull();
      expect(recovered.attempts).toBe(1); // consumed at claim, preserved by recovery

      expect(recoveryMs).toBeLessThan(EXPECTED_RECOVERY_CEILING_MS);
      expect(recoveryMs).toBeLessThan(60_000); // assignment crash rule

      // 6) It must actually run again and finish, not just leave 'processing'.
      await waitFor(
        () => jobs.getById("victim-job")?.state === "completed",
        45_000,
        "victim-job to complete on another worker",
      );

      const finished = jobs.getById("victim-job")!;
      expect(finished.state).toBe("completed");
      expect(finished.exitCode).toBe(0);
      expect(finished.attempts).toBe(2); // one crashed claim + one successful claim
      expect(finished.workerId).toBe(longOwner.id);

      // 7) Side effect must exist (the command actually ran to completion at
      //    least once). Two lines are allowed: the orphaned child from the
      //    SIGKILLed worker can finish while the recovered claim also runs.
      //    Zero lines would mean we marked completed without executing.
      //    Three+ would mean extra claims beyond the one crashed + one success
      //    already asserted by attempts === 2.
      const markerLines = fs.existsSync(markerPath)
        ? fs
            .readFileSync(markerPath, "utf8")
            .split("\n")
            .filter((line) => line.trim() !== "")
        : [];
      expect(markerLines.every((line) => line === "done")).toBe(true);
      expect(markerLines.length).toBeGreaterThanOrEqual(1);
      expect(markerLines.length).toBeLessThanOrEqual(2);

      expect(jobs.getById("long-job")!.state).toBe("completed");

      // Recovery ran once, not once per timer tick and not once per process.
      expect(countRecoveredEvents()).toBe(1);

      const recoveryLog = workerA.stderr
        .split("\n")
        .filter((line) => line.includes("Stale Job Recovered"));
      expect(recoveryLog.length).toBeGreaterThan(0);

      console.log(
        [
          "",
          "  ── crash recovery measurement ─────────────────────────────",
          `  lease-timeout-ms .............. ${LEASE_TIMEOUT_MS}`,
          `  recovery-interval-ms .......... ${RECOVERY_INTERVAL_MS}`,
          `  measured kill -> pending ...... ${recoveryMs} ms`,
          `  ceiling asserted .............. ${EXPECTED_RECOVERY_CEILING_MS} ms`,
          `  peer job state at recovery .... ${longJobStateAtRecovery}`,
          `  peer job elapsed at recovery .. ${longJobElapsedMs} ms of ${LONG_JOB_SECONDS * 1000} ms`,
          `  side-effect lines ............. ${markerLines.length}`,
          "  ───────────────────────────────────────────────────────────",
        ].join("\n"),
      );
    },
    120_000,
  );
});
