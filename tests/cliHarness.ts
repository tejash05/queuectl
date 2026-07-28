import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { closeDatabase, openDatabase, type SqliteDatabase } from "../src/database/database.js";
import { ConfigRepository } from "../src/repositories/ConfigRepository.js";
import { JobRepository } from "../src/repositories/JobRepository.js";
import { WorkerRepository } from "../src/repositories/WorkerRepository.js";
import { sleep } from "../src/utils/time.js";

/**
 * Black-box harness for the real CLI.
 *
 * Every command here goes through src/index.ts exactly as `queuectl ...` does
 * after `npm run build` — same argument parsing, same stdout/stderr split, same
 * exit codes. Tests that assert on the assignment's contracts must use this and
 * not reach into the repositories, which are only exposed for arranging state
 * and for reading results out of band while workers are running.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsxBin = path.join(repoRoot, "node_modules", ".bin", "tsx");
const cliEntry = path.join(repoRoot, "src", "index.ts");

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface WorkerHandle {
  child: ChildProcess;
  pid: number;
  stdout: string;
  stderr: string;
  exited: boolean;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
}

export interface QueueFixture {
  dir: string;
  dbPath: string;
  db: SqliteDatabase;
  jobs: JobRepository;
  workers: WorkerRepository;
  config: ConfigRepository;
  /** Run one CLI command to completion and capture stdout/stderr separately. */
  cli: (args: string[], extraEnv?: Record<string, string>) => CliResult;
  /** Launch `queuectl worker start` as an independent OS process. */
  startWorker: (args?: string[]) => WorkerHandle;
  markerPath: string;
  readMarkers: () => string[];
  cleanup: () => void;
}

const handles: WorkerHandle[] = [];

export function createQueueFixture(): QueueFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "queuectl-cli-"));
  const dbPath = path.join(dir, "queue.sqlite");
  const markerPath = path.join(dir, "side-effects.txt");
  const db = openDatabase(dbPath);
  const owned: WorkerHandle[] = [];

  const env = { ...process.env, QUEUECTL_DB: dbPath };

  const cli = (args: string[], extraEnv: Record<string, string> = {}): CliResult => {
    const result = spawnSync(tsxBin, [cliEntry, ...args], {
      cwd: repoRoot,
      env: { ...env, ...extraEnv },
      encoding: "utf8",
    });
    if (result.error) throw result.error;
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  };

  const startWorker = (args: string[] = ["worker", "start"]): WorkerHandle => {
    // detached puts the worker in its own process group so a test can SIGKILL
    // the worker together with the shell command it spawned.
    const child = spawn(tsxBin, [cliEntry, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const handle: WorkerHandle = {
      child,
      pid: child.pid!,
      stdout: "",
      stderr: "",
      exited: false,
      exitCode: null,
      exitSignal: null,
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      handle.stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      handle.stderr += chunk.toString("utf8");
    });
    child.on("exit", (code, signal) => {
      handle.exited = true;
      handle.exitCode = code;
      handle.exitSignal = signal;
    });

    handles.push(handle);
    owned.push(handle);
    return handle;
  };

  return {
    dir,
    dbPath,
    db,
    jobs: new JobRepository(db),
    workers: new WorkerRepository(db),
    config: new ConfigRepository(db),
    cli,
    startWorker,
    markerPath,
    readMarkers: () => readMarkers(markerPath),
    cleanup: () => {
      for (const handle of owned) {
        killWorker(handle);
      }
      closeDatabase(db);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Signal the whole process group; a bare pid would orphan `sh -c` children. */
export function killWorker(handle: WorkerHandle, signal: NodeJS.Signals = "SIGKILL"): void {
  if (handle.exited) return;
  try {
    process.kill(-handle.pid, signal);
  } catch {
    try {
      process.kill(handle.pid, signal);
    } catch {
      // Already gone.
    }
  }
}

export function killAllWorkers(): void {
  for (const handle of handles) {
    killWorker(handle);
  }
  handles.length = 0;
}

export async function waitFor(
  probe: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await sleep(50);
  }
}

export async function waitForExit(handle: WorkerHandle, timeoutMs: number): Promise<void> {
  await waitFor(() => handle.exited, timeoutMs, `worker pid ${handle.pid} to exit`);
}

/**
 * One line per successful execution. `echo x >> file` under O_APPEND is atomic
 * for writes this small, so concurrent workers cannot interleave a line and a
 * duplicate execution always shows up as a duplicate line.
 */
export function appendMarkerCommand(markerPath: string, token: string): string {
  return `echo ${token} >> '${markerPath}'`;
}

export function readMarkers(markerPath: string): string[] {
  if (!fs.existsSync(markerPath)) return [];
  return fs
    .readFileSync(markerPath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Parse a `--json` stdout payload, failing loudly on any non-JSON noise. */
export function parseJsonStdout<T>(result: CliResult, command: string): T {
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new Error(
      `stdout of \`queuectl ${command}\` was not valid JSON.\n` +
        `--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
}
