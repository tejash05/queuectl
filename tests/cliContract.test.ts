import { afterEach, describe, expect, it } from "vitest";
import type { JobJson } from "../src/models/Job.js";
import {
  createQueueFixture,
  killAllWorkers,
  parseJsonStdout,
  type QueueFixture,
} from "./cliHarness.js";

const REQUIRED_FIELDS = [
  "id",
  "command",
  "state",
  "attempts",
  "max_retries",
  "created_at",
  "updated_at",
] as const;

function assertJobJson(job: JobJson): void {
  for (const field of REQUIRED_FIELDS) {
    expect(job).toHaveProperty(field);
  }
  expect(Object.keys(job).sort()).toEqual([...REQUIRED_FIELDS].sort());
  expect(Number.isNaN(Date.parse(job.created_at))).toBe(false);
  expect(Number.isNaN(Date.parse(job.updated_at))).toBe(false);
}

describe("CLI JSON and exit-code contract", () => {
  let fx: QueueFixture;

  afterEach(() => {
    killAllWorkers();
    fx?.cleanup();
  });

  it("enqueue and list --json emit only a JSON payload with all seven required fields", () => {
    fx = createQueueFixture();

    const enqueued = fx.cli([
      "enqueue",
      '{"id":"json-test","command":"echo hello"}',
    ]);
    expect(enqueued.status).toBe(0);
    expect(enqueued.stdout.trim().startsWith("{")).toBe(true);
    const job = parseJsonStdout<JobJson>(enqueued, "enqueue");
    expect(job.id).toBe("json-test");
    expect(job.state).toBe("pending");
    expect(job.attempts).toBe(0);
    expect(job.max_retries).toBe(3);
    assertJobJson(job);

    const listed = fx.cli(["list", "--state", "pending", "--json"]);
    expect(listed.status).toBe(0);
    expect(listed.stdout.trim().startsWith("[")).toBe(true);
    const jobs = parseJsonStdout<JobJson[]>(listed, "list --state pending --json");
    expect(Array.isArray(jobs)).toBe(true);
    expect(jobs).toHaveLength(1);
    assertJobJson(jobs[0]!);
    expect(jobs[0]!.id).toBe("json-test");
  });

  it("every --json list command is a parseable array even when empty", () => {
    fx = createQueueFixture();
    for (const state of ["pending", "processing", "completed", "failed", "dead"] as const) {
      const result = fx.cli(["list", "--state", state, "--json"]);
      expect(result.status).toBe(0);
      expect(parseJsonStdout<JobJson[]>(result, `list --state ${state} --json`)).toEqual([]);
    }
    const dlq = fx.cli(["dlq", "list", "--json"]);
    expect(dlq.status).toBe(0);
    expect(parseJsonStdout<JobJson[]>(dlq, "dlq list --json")).toEqual([]);
  });

  it("rejects invalid CLI input with a non-zero exit code", () => {
    fx = createQueueFixture();

    expect(fx.cli(["enqueue", "not-json"]).status).toBe(1);
    expect(fx.cli(["list", "--state", "nope"]).status).toBe(2);
    expect(fx.cli(["dlq", "retry"]).status).toBe(2);
    expect(fx.cli(["dlq", "retry", "missing"]).status).toBe(1);
    expect(fx.cli(["worker", "start", "--count", "0"]).status).toBe(2);
    expect(fx.cli(["config", "set", "max-retries", "2.5"]).status).toBe(2);
    expect(fx.cli(["config", "set", "max-retries", "-1"]).status).toBe(2);
    expect(fx.cli(["config", "set", "backoff-base", "0"]).status).toBe(2);
    expect(fx.cli(["config", "set", "backoff-base", "-2"]).status).toBe(2);
    expect(fx.cli(["config", "set", "lease-timeout-ms", "0"]).status).toBe(2);
    expect(fx.cli(["config", "set", "not-a-key", "1"]).status).toBe(2);
  });

  it("persists config across a new CLI process", () => {
    fx = createQueueFixture();
    expect(fx.cli(["config", "set", "max-retries", "5"]).status).toBe(0);
    expect(fx.cli(["config", "get", "max-retries"]).stdout.trim()).toBe("5");
  });
});
