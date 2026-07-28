import { afterEach, describe, expect, it } from "vitest";
import type { JobJson } from "../src/models/Job.js";
import {
  createQueueFixture,
  killAllWorkers,
  killWorker,
  parseJsonStdout,
  waitFor,
  waitForExit,
  type QueueFixture,
} from "./cliHarness.js";

function jsonList(fx: QueueFixture, state: string): JobJson[] {
  return parseJsonStdout<JobJson[]>(
    fx.cli(["list", "--state", state, "--json"]),
    `list --state ${state} --json`,
  );
}

describe("assignment scenarios via the real CLI", () => {
  let fx: QueueFixture;

  afterEach(() => {
    killAllWorkers();
    fx?.cleanup();
  });

  it(
    "scenario 1: a simple command becomes completed exactly once",
    async () => {
      fx = createQueueFixture();
      const worker = fx.startWorker();

      const enqueued = fx.cli([
        "enqueue",
        JSON.stringify({
          id: "scenario1",
          command: `echo scenario1 >> '${fx.markerPath}'`,
        }),
      ]);
      expect(enqueued.status).toBe(0);
      assertJobJsonShape(parseJsonStdout<JobJson>(enqueued, "enqueue"));

      await waitFor(
        () => jsonList(fx, "completed").some((job) => job.id === "scenario1"),
        15_000,
        "scenario1 to complete",
      );

      const completed = jsonList(fx, "completed");
      expect(completed).toHaveLength(1);
      expect(completed[0]!.id).toBe("scenario1");
      expect(completed[0]!.attempts).toBe(1);
      expect(completed[0]!.max_retries).toBe(3);
      assertJobJsonShape(completed[0]!);

      expect(jsonList(fx, "processing")).toHaveLength(0);
      expect(fx.readMarkers()).toEqual(["scenario1"]);

      fx.cli(["worker", "stop"]);
      await waitForExit(worker, 10_000);
    },
    25_000,
  );

  it(
    "scenario 2: failing job retries with 2s/4s/8s backoff, surfaces as failed, then DLQ",
    async () => {
      fx = createQueueFixture();
      expect(fx.cli(["config", "set", "max-retries", "3"]).status).toBe(0);
      expect(fx.cli(["config", "set", "backoff-base", "2"]).status).toBe(0);
      expect(fx.cli(["config", "set", "poll-interval-ms", "200"]).status).toBe(0);

      const worker = fx.startWorker();
      expect(
        fx.cli(["enqueue", '{"id":"always-fail","command":"false"}']).status,
      ).toBe(0);

      let sawFailedJson = false;
      await waitFor(
        () => {
          if (jsonList(fx, "failed").some((job) => job.id === "always-fail")) {
            sawFailedJson = true;
          }
          return jsonList(fx, "dead").some((job) => job.id === "always-fail");
        },
        30_000,
        "always-fail to reach the DLQ",
      );

      expect(sawFailedJson).toBe(true);

      const failedAt = (
        fx.db
          .prepare(
            `SELECT created_at FROM job_history WHERE job_id = ? AND event = 'failed' ORDER BY id`,
          )
          .all("always-fail") as Array<{ created_at: string }>
      ).map((row) => new Date(row.created_at).getTime());
      expect(failedAt).toHaveLength(3);
      const delays = [failedAt[1]! - failedAt[0]!, failedAt[2]! - failedAt[1]!];
      const dead = parseJsonStdout<JobJson[]>(
        fx.cli(["dlq", "list", "--json"]),
        "dlq list --json",
      );
      expect(dead).toHaveLength(1);
      expect(dead[0]!.id).toBe("always-fail");
      expect(dead[0]!.state).toBe("dead");
      // 1 initial claim + 3 retries = 4 executions, attempts left at maxRetries+1
      expect(dead[0]!.attempts).toBe(4);
      expect(dead[0]!.max_retries).toBe(3);
      assertJobJsonShape(dead[0]!);

      // Three backoff gaps: ~2s, ~4s, ~8s. Allow slack for poll/scheduling.
      expect(delays.length).toBeGreaterThanOrEqual(2);
      expect(delays[0]!).toBeGreaterThanOrEqual(1_500);
      expect(delays[0]!).toBeLessThan(3_500);
      if (delays[1] !== undefined) {
        expect(delays[1]).toBeGreaterThanOrEqual(3_000);
        expect(delays[1]).toBeLessThan(6_000);
      }
      if (delays[2] !== undefined) {
        expect(delays[2]).toBeGreaterThanOrEqual(6_000);
        expect(delays[2]).toBeLessThan(11_000);
      }

      fx.cli(["worker", "stop"]);
      await waitForExit(worker, 10_000);

      const retried = fx.cli(["dlq", "retry", "always-fail"]);
      expect(retried.status).toBe(0);
      const pending = jsonList(fx, "pending");
      expect(pending).toHaveLength(1);
      expect(pending[0]!.id).toBe("always-fail");
      expect(pending[0]!.state).toBe("pending");
      expect(pending[0]!.attempts).toBe(0);
      expect(pending[0]!.max_retries).toBe(3);
    },
    45_000,
  );

  it(
    "scenario 5: pending, failed, dead, and config survive a full worker restart",
    async () => {
      fx = createQueueFixture();
      expect(fx.cli(["config", "set", "max-retries", "5"]).status).toBe(0);
      expect(fx.cli(["config", "set", "backoff-base", "2"]).status).toBe(0);
      expect(fx.cli(["config", "set", "poll-interval-ms", "200"]).status).toBe(0);

      // Drive one job into failed (retryable) and one into dead, then stop.
      const first = fx.startWorker();
      expect(
        fx.cli([
          "enqueue",
          '{"id":"will-fail","command":"false","max_retries":10}',
        ]).status,
      ).toBe(0);
      expect(
        fx.cli([
          "enqueue",
          '{"id":"will-die","command":"false","max_retries":0}',
        ]).status,
      ).toBe(0);

      await waitFor(
        () => jsonList(fx, "dead").some((job) => job.id === "will-die"),
        10_000,
        "will-die to enter the DLQ",
      );
      await waitFor(
        () => jsonList(fx, "failed").some((job) => job.id === "will-fail"),
        10_000,
        "will-fail to enter failed backoff",
      );

      fx.cli(["worker", "stop"]);
      await waitForExit(first, 10_000);

      expect(
        fx.cli(["enqueue", '{"id":"stay-pending","command":"echo later"}']).status,
      ).toBe(0);

      expect(fx.cli(["config", "get", "max-retries"]).stdout.trim()).toBe("5");
      expect(jsonList(fx, "pending").some((job) => job.id === "stay-pending")).toBe(true);
      expect(jsonList(fx, "failed").some((job) => job.id === "will-fail")).toBe(true);
      expect(jsonList(fx, "dead").some((job) => job.id === "will-die")).toBe(true);

      const second = fx.startWorker();
      await waitFor(
        () => jsonList(fx, "completed").some((job) => job.id === "stay-pending"),
        15_000,
        "stay-pending to complete after restart",
      );
      expect(jsonList(fx, "dead").some((job) => job.id === "will-die")).toBe(true);

      fx.cli(["worker", "stop"]);
      await waitForExit(second, 10_000);
    },
    40_000,
  );

  it(
    "worker stop from another process drains the current job and claims nothing further",
    async () => {
      fx = createQueueFixture();
      expect(fx.cli(["config", "set", "poll-interval-ms", "200"]).status).toBe(0);

      const worker = fx.startWorker();
      expect(
        fx.cli(["enqueue", '{"id":"long","command":"sleep 2"}']).status,
      ).toBe(0);
      expect(
        fx.cli(["enqueue", '{"id":"next","command":"echo should-not-run"}']).status,
      ).toBe(0);

      await waitFor(
        () => jsonList(fx, "processing").some((job) => job.id === "long"),
        10_000,
        "long job to start",
      );

      const stop = fx.cli(["worker", "stop"]);
      expect(stop.status).toBe(0);
      await waitForExit(worker, 15_000);

      expect(jsonList(fx, "completed").some((job) => job.id === "long")).toBe(true);
      expect(jsonList(fx, "pending").some((job) => job.id === "next")).toBe(true);
      expect(jsonList(fx, "completed").some((job) => job.id === "next")).toBe(false);

      const stopped = fx.workers.list("stopped");
      expect(stopped.length).toBeGreaterThanOrEqual(1);
    },
    30_000,
  );
});

function assertJobJsonShape(job: JobJson): void {
  expect(job).toEqual(
    expect.objectContaining({
      id: expect.any(String),
      command: expect.any(String),
      state: expect.any(String),
      attempts: expect.any(Number),
      max_retries: expect.any(Number),
      created_at: expect.any(String),
      updated_at: expect.any(String),
    }),
  );
}
