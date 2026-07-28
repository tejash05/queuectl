import { afterEach, describe, expect, it } from "vitest";
import type { JobJson } from "../src/models/Job.js";
import {
  appendMarkerCommand,
  createQueueFixture,
  killAllWorkers,
  parseJsonStdout,
  waitFor,
  waitForExit,
  type QueueFixture,
} from "./cliHarness.js";

/**
 * Assignment scenario 3: many jobs, separate OS processes, each job runs once.
 *
 * `--count N` is N schedulers inside one process and is a different claim.
 * This test launches two `queuectl worker start` processes with distinct PIDs.
 */
describe("multi-process claiming via the real CLI", () => {
  let fx: QueueFixture;

  afterEach(() => {
    killAllWorkers();
    fx?.cleanup();
  });

  it(
    "scenario 3: two OS worker processes complete N jobs with no duplicates",
    async () => {
      fx = createQueueFixture();
      expect(fx.cli(["config", "set", "poll-interval-ms", "50"]).status).toBe(0);

      const n = 40;
      for (let i = 0; i < n; i += 1) {
        const id = `job-${i}`;
        const result = fx.cli([
          "enqueue",
          JSON.stringify({ id, command: appendMarkerCommand(fx.markerPath, id) }),
        ]);
        expect(result.status).toBe(0);
      }

      const a = fx.startWorker();
      const b = fx.startWorker();
      expect(a.pid).not.toBe(b.pid);

      await waitFor(
        () => {
          const live = fx.workers.list().filter((w) => w.status === "active");
          return live.length >= 2 && new Set(live.map((w) => w.pid)).size >= 2;
        },
        10_000,
        "two active workers with distinct OS PIDs",
      );

      await waitFor(
        () => parseJsonStdout<JobJson[]>(fx.cli(["list", "--state", "completed", "--json"]), "list").length === n,
        30_000,
        `all ${n} jobs to complete`,
      );

      const completed = parseJsonStdout<JobJson[]>(
        fx.cli(["list", "--state", "completed", "--json"]),
        "list --state completed --json",
      );
      expect(completed).toHaveLength(n);
      expect(new Set(completed.map((job) => job.id)).size).toBe(n);
      expect(completed.every((job) => job.attempts === 1)).toBe(true);

      const processing = parseJsonStdout<JobJson[]>(
        fx.cli(["list", "--state", "processing", "--json"]),
        "list --state processing --json",
      );
      expect(processing).toHaveLength(0);

      const markers = fx.readMarkers();
      expect(markers).toHaveLength(n);
      expect(new Set(markers).size).toBe(n);

      fx.cli(["worker", "stop"]);
      await waitForExit(a, 10_000);
      await waitForExit(b, 10_000);
    },
    45_000,
  );
});
