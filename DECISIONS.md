# QueueCTL Engineering Decisions

Answers to the five required assignment questions, in order. Every implementation claim below cites the exact file, method, and line numbers so it can be checked against the code.

Line numbers refer to `src/` (TypeScript source). Defaults quoted are from `src/utils/constants.ts:6-16`. Supporting sections after Q5 cover the rest of the interface contract (states, JSON stdout, config, `--count`, SIGINT/SIGTERM vs SIGKILL) so those decisions are as checkable as the numbered answers.

---

## Q1. Which exact line(s) prevent two workers from claiming the same job, and why is that operation atomic across separate OS processes?

**Answer: `src/repositories/JobRepository.ts:166`, `:148`, and the single statement at `:134-153`, inside `JobRepository.claimNext()` (`:130-167`).**

Three lines do the work:

| Line | Code | Role |
|---|---|---|
| `JobRepository.ts:166` | `return run.immediate();` | Runs the claim under `BEGIN IMMEDIATE` — the cross-process lock |
| `JobRepository.ts:148` | `WHERE state IN ('pending', 'failed')` | The guard predicate — the loser cannot re-select a claimed row |
| `JobRepository.ts:134-153` | `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *` | Select and mutate in one statement — no read-then-write window |

### Why `BEGIN IMMEDIATE`

`this.db.transaction(...)` is created at `JobRepository.ts:131` and invoked via `.immediate()` at `:166`. In `better-sqlite3` v11.10.0 that variant emits the literal string `BEGIN IMMEDIATE` (`node_modules/better-sqlite3/lib/methods/transaction.js:44`).

A plain `BEGIN` (deferred) starts as a reader and only tries to take the write lock on first write, which allows two processes to both read the same pending row before either writes. `BEGIN IMMEDIATE` acquires the write lock at transaction **start**, so the two claims serialize before either can observe the queue.

### Why this holds across separate OS processes, not just threads

SQLite's single-writer rule is enforced by an **advisory lock held by the operating system on the database file** (in WAL mode, on the write-lock region of the `-shm` file). It is not a mutex in the JavaScript heap, not a `better-sqlite3` object, and not scoped to a process. Two unrelated `node` PIDs opening the same path contend for the same kernel-held lock, which is exactly what makes this work when `queuectl worker start` is run in two different terminals.

Supporting pragmas, set once per connection in `openDatabase()`:

- `src/database/database.ts:21` — `db.pragma("journal_mode = WAL")`: readers (`status`, `list`) never block the claim writer.
- `src/database/database.ts:22` — `db.pragma("busy_timeout = 5000")`: the process that loses the race **waits and retries for up to 5 s** instead of throwing `SQLITE_BUSY`. Without this, a contended claim would surface as a crash rather than a delay.

Serialization alone is not sufficient — it must also be impossible for the loser to pick the same row. That is guaranteed by `JobRepository.ts:146-152`: the target row is chosen by a subquery filtered on `state IN ('pending', 'failed')` (`:148`) **inside the same statement** as the mutation. By the time process B holds the write lock, process A has committed `state = 'processing'`, so B's subquery skips that row and returns the next runnable job or nothing. On nothing, `claimNext` returns `null` and the scheduler sleeps (`src/core/Scheduler.ts:73-76`).

### Multiple schedulers in one process vs. workers from separate terminals

These are two different concurrency problems and only one of them needs the lock:

- **`worker start --count 3` (one OS process).** `src/cli/worker.ts:31` opens **one** connection; `:33` builds **one** `JobRepository`; `:50-61` registers 3 worker rows and 3 `Scheduler` instances sharing it; `:71` runs them under `Promise.all`. `better-sqlite3` is fully synchronous, so a `claimNext` call runs to completion before the event loop can resume another scheduler. Interleaving is impossible here regardless of transaction mode — safety comes from the single-threaded synchronous API, not from `BEGIN IMMEDIATE`.
- **`worker start` in two terminals (two OS processes).** Two independent connections to the same file, two event loops, genuine parallelism. This is the case `BEGIN IMMEDIATE` + `busy_timeout` exists for, and the only case where the file lock is load-bearing.

**Options considered:** (A) `SELECT` then `UPDATE … WHERE state='pending'` with retry on zero rows affected — correct but needs a retry loop and wastes work under contention; (B) an external lock service such as Redis `SETNX` — adds a network dependency and a second source of truth for a single-node CLI; (C) chosen: one statement under `BEGIN IMMEDIATE`.

**Trade-off:** throughput is capped by SQLite's single-writer rule; every claim serializes globally. Acceptable for a single-host CLI queue, wrong for multi-host high QPS.

**Verified by:** `tests/jobClaim.test.ts:29-53` — with one pending job, the second `claimNext` returns `null`.

---

## Q2. A worker is SIGKILLed halfway through a job. What state is the job in, how does it run again, and what is the worst-case delay?

Recovery is driven by a **timer that is deliberately not part of the claim/execute loop** (`src/core/RecoveryRunner.ts`). The reason is in Q2's own failure mode: a scheduler blocks on `await this.executeAndSettle(job)` (`src/core/Scheduler.ts:88`) for the entire duration of its job, so recovery driven from that loop cannot run while the worker is busy — a crashed peer's job would wait for someone else's long command to finish.

### Step-by-step

| # | Step | Code |
|---|---|---|
| 1 | Lease created at claim: `lease_until = now + lease-timeout-ms` | `Scheduler.ts:64-66` computes it; written by the claim UPDATE at `JobRepository.ts:134-153` (`lease_until` at `:137`) |
| 2 | `attempts` incremented **at claim time**, not at failure | `JobRepository.ts:140` |
| 3 | Heartbeat timer extends the lease every `heartbeat-interval-ms` | `Scheduler.ts:49-53` starts it; `tickHeartbeat` at `:100-109`; `jobs.extendLease` at `:105-107` → `JobRepository.ts:264-270` |
| 4 | **SIGKILL** — not trappable, no handler runs | `src/utils/signals.ts:11-12` registers only SIGINT/SIGTERM |
| 5 | Job frozen: `state='processing'`, `worker_id` = dead worker, `lease_until` in the future | (no write occurs — that is the point) |
| 6 | Heartbeats stop, so `lease_until` stops moving and wall-clock passes it | — |
| 7 | **Independent recovery timer** in every live worker process fires | `RecoveryRunner.start():29-42`, `setInterval` at `:38`, `tick()` at `:56-66` → `RecoveryService.recover():71-76` |
| 8 | Expiry detected by a lock-free indexed probe | `JobRepository.ts:283-291`; returns early at `:293-295` when nothing is stale |
| 9 | Recovery resets to `pending`, clears `worker_id`/`lease_until`/`started_at`, sets `available_at = now` | `JobRepository.ts:316-324` inside the transaction opened at `:297`; audit row at `:330-333` |
| 10 | Logged for the operator | `RecoveryService.ts:35-41` — `Stale Job Recovered` with `previous_worker`, `previous_lease_until`, `reason=lease_expired` |
| 11 | Re-claimed by any worker with a free scheduler; `attempts` increments again | `Scheduler.ts:67-71` → `JobRepository.ts:134-153` |
| 12 | Dead worker row flipped `active → stopped` (cosmetic; does not reclaim jobs) | `RecoveryService.recoverStaleWorkers():51-68` → `WorkerRepository.markStaleAsStopped:97-111` |

Attempts being consumed at claim (step 2) is deliberate: `RetryService` dead-letters on `job.attempts > job.maxRetries` (`src/core/RetryService.ts:33`), so a poison job that reliably kills its worker still exhausts its budget instead of crash-looping forever. Asserted in `tests/recovery.test.ts:133,148`.

### Why the recovery loop is independent, and why that is safe

- **Independence.** Job execution is async I/O — `JobExecutor` resolves on child-process events (`src/core/JobExecutor.ts:39-45`, `:77-92`) — so the Node event loop stays free while a command runs and `setInterval` keeps firing. This is the same mechanism that already lets the heartbeat extend a long job's own lease.
- **Process-level, not scheduler-level.** The runner is constructed once per worker process (`src/cli/worker.ts:42`) and started before any scheduler (`:48`), so `--count N` yields one recovery timer, not N.
- **No duplicate recovery.** `recoverExpiredLeases` re-reads stale rows *inside* a transaction committed with `recover.immediate()` (`JobRepository.ts:345`). Concurrent runners in other processes serialize on SQLite's write lock; the loser's re-read (`:299-305`) sees the rows already back in `pending` and recovers nothing. That prevents a duplicate `recovered` history row; it does not prevent the command from running twice (see at-least-once below).
- **No race with claiming.** Recovery only touches `state='processing'` rows; `claimNext` only touches `state IN ('pending','failed')` rows, and both commit under `BEGIN IMMEDIATE`.
- **Cheap when idle.** The common case is a single indexed read with no write lock taken (`:283-291`).
- **Failure-tolerant.** `tick()` swallows and logs errors (`RecoveryRunner.ts:59-65`), because an uncaught throw inside a timer callback would kill the worker process.
- **Graceful shutdown.** `recoveryRunner.stop()` runs in the `finally` block at `src/cli/worker.ts:78`, before `closeDatabase(db)` at `:80`, so a firing timer can never query a closed database. `stop()` is `RecoveryRunner.ts:44-49`; the timer is also `unref()`d at `:39` so it never keeps the process alive on its own.

### Recovery timing (stated precisely)

Defaults: `lease-timeout-ms = 30_000` (`constants.ts:9`), `heartbeat-interval-ms = 5_000` (`:10`), `recovery-interval-ms = 5_000` (`:13`), `poll-interval-ms = 1_000` (`:14`).

Heartbeat and lease are separate knobs on purpose. Heartbeat (`heartbeat-interval-ms`) is how often a *live* worker renews `lease_until`; lease (`lease-timeout-ms`) is how long a *dead* worker's claim stays believed. One number cannot do both: a 5 s lease would steal still-running jobs between heartbeats, and a 30 s heartbeat would make crash detection miss the assignment's 60 s bound. `config set` enforces `lease-timeout-ms >= 2 × heartbeat-interval-ms` (`ConfigRepository.ts:67-81`, `MIN_LEASE_TO_HEARTBEAT_RATIO` in `constants.ts:82`) so a single bad write cannot create that race.

Because the lease is refreshed every 5 s to a 30 s horizon, the lease still has 25–30 s left at the moment of the kill. Detection then waits at most one recovery interval:

```
detection = lease residual (25–30s) + recovery tick (≤5s)  ≈ 30–35s
```

**Measured end-to-end at defaults: 34.6 s** (SIGKILL → `recovered` event), with the surviving worker 35 s into a 90 s job — comfortably inside the assignment's 60 s limit. `tests/crashRecoveryWhilePeerBusy.test.ts` runs the same scenario on compressed timings and prints the measured value.

**What this bound does and does not guarantee:**

- It holds **while at least one worker process is alive**, and it no longer depends on whether that worker is busy — which was the whole point of the change. The end-to-end test asserts the peer's job is still `processing` at the moment recovery happens.
- If **every** worker process is killed, nothing is running to notice the expired lease. The job stays `processing` until an operator runs `queuectl worker start` (the runner's immediate first pass at `RecoveryRunner.ts:36` recovers before any scheduler starts) or `queuectl status`, which calls `RecoveryService.recover()` before rendering (`src/cli/status.ts:27`). No in-process timer can cover this case; only a separate always-on daemon could, which is out of scope for a CLI tool.
- **Detection is not completion.** Recovery returns the job to `pending`; re-execution still needs a scheduler with a free slot. If every live worker is mid-job, the job waits — correctly visible as `pending`, not stuck in `processing`.

**Options considered:** (A) key recovery off worker liveness (`workers.status` / heartbeat) — rejected because it couples job safety to worker-row bookkeeping and cannot recover a job whose worker row was deleted; (B) recovery inside the scheduler poll loop — this was the original design, and it is what the independent timer replaces: it stalls for the length of the worker's own job; (C) a dedicated recovery OS process or daemon — the only design that also covers "all workers dead", but it adds a process to supervise, a second lifecycle to manage, and a new failure mode of its own for a single-host CLI; (D) chosen: per-job lease plus a process-level recovery timer inside each worker.

**Trade-offs, honestly:** recovery is at-least-once, so a job may execute twice after a crash — commands should be idempotent. SIGKILL cannot run cleanup, and the job child is spawned `detached` (`JobExecutor.ts:39-45`), so it is not in the worker's process group: killing the worker (PID or `kill -- -<pgid>`) does not reap the in-flight command. That orphan may still finish while recovery re-claims the row and another worker runs the command again. A worker that is alive but wedged and no longer heartbeating will have its job stolen after the lease window. The ~35 s figure is conditional on a live worker process, as stated above. This is the assignment crash rule (nothing stuck in `processing` forever), not exactly-once execution. Scenario 3's "exactly once" applies to *live* competing workers, which `BEGIN IMMEDIATE` claiming enforces.

---

## Q3. Does `dlq retry` reset attempts? Why is that the right call?

**Answer: yes — `attempts = 0` at `src/repositories/JobRepository.ts:363`, in `requeueDead()` (`:352-380`).**

The same UPDATE sets `state='pending'` (`:362`), `available_at = now` (`:364`), and clears `worker_id`, `lease_until`, `last_error`, `exit_code`, `stdout`, `stderr`, `started_at`, `finished_at` (`:365-372`). CLI path: `src/cli/dlq.ts:62-91` (`:83`) → `JobService.retryDead` (`src/core/JobService.ts:86-93`); `--all` goes through `:78` → `requeueAllDead` (`JobRepository.ts:382-392`).

Two implementation-specific reasons make the reset necessary here, not merely nice:

**1. Attempts are incremented at claim time, so a dead job is already over budget.** `attempts` is bumped in the claim UPDATE (`JobRepository.ts:140`) and `RetryService` dead-letters on `job.attempts > job.maxRetries` (`src/core/RetryService.ts:33`). A job in the DLQ therefore always sits at `attempts == maxRetries + 1` by construction. Without the reset, the next claim would push it to `maxRetries + 2` and the very first failure would send it straight back to the DLQ — the operator's retry would buy exactly one execution and zero retries, silently. The reset is what makes `dlq retry` mean what the operator thinks it means.

**2. `attempts` is the exponent of the backoff.** Retry delay is `backoff-base ** attempts` (`src/utils/backoff.ts:17`, called from `RetryService.ts:50-51`). Carrying attempts forward carries the exponent forward: with defaults the first post-retry delay would be `2^5 = 32 s` instead of `2 s`, doubling again on every DLQ round-trip until the job was effectively unschedulable. Resetting re-anchors the backoff curve.

**`max_retries` is deliberately *not* reset.** It is snapshotted onto the row at enqueue (`JobRepository.ts:70`, value chosen at `JobService.ts:42-45`) and `requeueDead`'s UPDATE (`:361-374`) does not list it. So a retried job gets a **fresh budget of its original size**, not a new policy — a job enqueued with `max_retries: 1` does not silently inherit today's `config set max-retries 10`. This keeps per-job retry policy immutable for the life of the job, which is the same rule the normal retry path follows.

**Safety of the reset.** It cannot touch a live job: `requeueDead` pre-checks `job.state !== "dead"` and returns `null` (`:354-356`), and the UPDATE is additionally guarded by `WHERE id = ? AND state = 'dead'` (`:374`). Running it twice is a no-op.

**Options considered:** (A) preserve attempts — rejected for reasons 1 and 2 above; (B) chosen: reset to 0; (C) reset only with an explicit `--max-retries` override — rejected as extra CLI surface for the common case, and the assignment specifies plain `dlq retry <id>`.

**Trade-off:** an operator can cycle a permanently broken job forever by re-running `dlq retry`. That is intentional — it is human-initiated, one decision per invocation, and never happens automatically.

---

## Q4. What designs did you consider and reject for worker stop (cross-process signalling), and why?

**Chosen: a cooperative flag in the shared SQLite file. The database *is* the signalling channel.**

### What `queuectl worker stop` actually does

**Stopping side** (a separate OS process, e.g. terminal 2): `src/cli/worker.ts:84-99` opens its own connection to the same DB file (`:88`) and calls `requestStopAll()` (`:91` → `WorkerService.ts:35-39` → `WorkerRepository.ts:72-83`). The write is one statement:

```
UPDATE workers SET status = 'stopping', last_heartbeat_at = ?
WHERE status IN ('active', 'stopping')      -- WorkerRepository.ts:76-79
```

The CLI then prints and exits (`cli/worker.ts:92`) — it is **fire-and-forget** and does not wait for workers to reach `stopped`, so `status` run immediately afterward can legitimately still show `stopping`.

**Observing side** (the worker process, terminal 1): the flag is read **only in the polling loop**, at `src/core/Scheduler.ts:57` — `if (workerService.shouldStop(workerId))`. `WorkerService.shouldStop` (`:59-62`) re-reads the worker row from SQLite on each call and returns true for `stopping`, `stopped`, or a missing row. On true, `Scheduler.ts:58-60` calls `requestShutdown("stop_command")` and breaks the loop; the `finally` block (`:91-97`) clears the heartbeat timer and writes `status='stopped'` + `stopped_at` (`:96` → `WorkerRepository.markStopped:85-91`). When every scheduler loop has returned, `Promise.all` at `src/cli/worker.ts:71` resolves, the recovery timer is stopped (`:78`), the connection closes (`:80`), and the process exits.

**The heartbeat does not check the stop flag.** `tickHeartbeat` (`Scheduler.ts:100-109`) only refreshes `last_heartbeat_at` and extends the job lease. The polling loop is the sole observer.

### Draining and latency

The check at `Scheduler.ts:57` sits **before** the claim (`:67`) and **after** the previous job has settled (`:88`). That ordering gives the drain semantics we want: no new job is claimed once a stop is requested, and the in-flight job is never abandoned.

Latency follows directly from where the check sits:

- **Idle worker:** ≤ 1 × `poll-interval-ms` (1 s, `constants.ts:14`), since it is sleeping at `Scheduler.ts:74`.
- **Busy worker:** the full remaining runtime of its current command — `:57` is not reached until `:88` returns.

`Ctrl+C` / `SIGTERM` drain the *same scheduler flag* (`stopping`) but through a different channel: `src/utils/signals.ts:11-12` → `src/cli/worker.ts:65-69` → `Scheduler.requestShutdown` (`:34-42`). Signals flip an in-memory flag in the worker process; `worker stop` flips a DB row that another process can write. The in-flight command is allowed to finish because of how it is spawned — see **Job execution and graceful SIGINT/SIGTERM** below. `tests/gracefulShutdown.test.ts:6-22` covers the cooperative DB flag only, not the signal path.

### Rejected: SIGTERM/SIGKILL by PID from the stopping CLI

This was the obvious alternative and it was **actually available** — the `workers` table already stores `pid` and `hostname` (`src/database/schema.ts:16-17`, written from `process.pid` at `WorkerService.ts:13` → `WorkerRepository.ts:25`), so `worker stop` could have read the PIDs and called `process.kill()`. It was rejected, not overlooked:

- A PID is only meaningful on the machine that wrote it. `hostname` is recorded but nothing validates it, so a row written by another host would target an unrelated local process.
- The OS reuses PIDs, and the rows most likely to be stale are exactly the ones left by SIGKILLed workers that never ran `markStopped` (`WorkerRepository.ts:85-91`) — signalling those risks killing an innocent process.
- Signalling requires the stopping CLI to run as a user permitted to signal the worker, which is not guaranteed under process managers or across users.
- A signal also cannot express "finish your current job first" without a handler on the other side — which is just the cooperative design again, with an extra failure mode.

### Rejected: PID files on disk

Standard for daemons, but it introduces a second source of truth that must be kept consistent with the `workers` table, with no atomic cleanup after SIGKILL — stale files accumulate and carry the same PID-reuse hazard. Since SQLite is already the durable, transactional coordination point for jobs and leases, a second one only creates the possibility of the two disagreeing.

### Rejected: per-worker Unix socket / named pipe

This is the design that would give genuinely instant stop and interruptible sleeps. Rejected on cost/benefit: each worker would have to bind and serve a control endpoint, clean up socket files after a crash, and follow a discovery convention — real machinery for a stop path that is already tolerant of a one-second delay. It also would not remove the SQLite dependency, since claiming and leases require it regardless.

**Trade-offs.** Stop is cooperative, not an instant remote kill — a worker running a long command stops when that command finishes. Stop is currently **global**: the UPDATE at `WorkerRepository.ts:78` has no ID predicate and the CLI exposes no target flag. `WorkerService.requestStop(workerId)` (`:29-33`) already implements the per-worker case, but no command is wired to it, because the assignment specifies `worker stop` with no argument.

---

## Q5. If priorities were added tomorrow (high-priority jobs jump the queue), what survives and what breaks?

The system has exactly **one** ordering decision — `ORDER BY created_at ASC` at `src/repositories/JobRepository.ts:150`, inside the claim subquery (`:146-152`). That containment is what makes this change small.

### A. Survives unchanged

- **Atomic claiming.** `BEGIN IMMEDIATE` (`JobRepository.ts:166`) and the `UPDATE … RETURNING` statement (`:134-153`) are indifferent to ordering. Priority changes *which* row the subquery selects, never *how* exclusion works. The concurrency guarantee is not coupled to the scheduling policy.
- **Leases and crash recovery.** `recoverExpiredLeases` (`:282-346`) filters on `state` + `lease_until` and never orders, and `RecoveryRunner` (`src/core/RecoveryRunner.ts`) is oblivious to job contents. `idx_jobs_lease_until` (`src/database/schema.ts:60-61`) is unaffected. Recovery resets `available_at` to `now` (`:323`) while leaving other columns alone, so a recovered high-priority job keeps its priority and returns to the front.
- **Retry and backoff.** `RetryService.handleFailure` (`src/core/RetryService.ts:29-72`) and `scheduleRetry` (`JobRepository.ts:227-262`) touch `state`, `available_at`, `attempts`, and error fields — not ordering.
- **DLQ.** `listDead` (`:348-350`) and `requeueDead` (`:352-380`) enumerate columns explicitly and never clear priority, so a requeued job keeps it.
- **Worker management.** The entire `workers` table, heartbeats, `worker stop`, and graceful shutdown are untouched.
- **The scheduler loop.** `Scheduler.run` (`src/core/Scheduler.ts:44-98`) calls `claimNext` and expresses no opinion about which job it gets back.
- **The migration framework.** `src/database/migrations.ts:73-216` already supports appending a versioned migration; `004_drop_retired_config_keys` is the most recent example.

### B. Must change

1. `src/database/schema.ts:24-44` — add `priority INTEGER NOT NULL DEFAULT 0` to the `jobs` DDL.
2. `src/database/migrations.ts` — add migration id 5 running `ALTER TABLE jobs ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`. **Required**, because `SCHEMA_SQL` uses `CREATE TABLE IF NOT EXISTS`, so existing databases would silently never gain the column.
3. `src/repositories/JobRepository.ts:150` — `ORDER BY created_at ASC` becomes `ORDER BY priority DESC, created_at ASC`. One line; this is the entire behavioural change.
4. `src/database/schema.ts:54-55` — replace the claim index (details below).
5. `src/repositories/JobRepository.ts:7-12` (`CreateJobInput`) and `:62-70` (`INSERT` column list and placeholders).
6. `src/core/JobService.ts:8-12` (`EnqueuePayload`) and `:42-55` — accept and validate `priority`. Today a `priority` key in the enqueue JSON is **silently dropped**, since `enqueueFromJson` reads only `id`, `command`, and `max_retries`.
7. `src/models/Job.ts` — `Job` (`:3-21`), `JobRow` (`:37-55`), `mapJobRow` (`:57-77`), and `toJobJson` (`:79-89`) if priority should appear in JSON output. Changing `toJobJson` changes the machine-readable contract emitted by `enqueue` (`src/cli/enqueue.ts:27`), `list --json`, and `dlq list --json` (`src/cli/dlq.ts:35`).
8. `tests/jobClaim.test.ts:20` asserts strict oldest-first and needs a companion priority-ordering case.

### The index, corrected

The current index is `idx_jobs_state_available_at ON jobs (state, available_at)` (`schema.ts:54-55`).

**`(state, available_at, priority, created_at)` is the wrong index and should not be used.** In the claim subquery, `available_at` is constrained by an **inequality** (`available_at <= ?`, `JobRepository.ts:149`). SQLite can derive sort order from an index only through its equality-constrained prefix; the first range-constrained column ends the usable ordering, and every column after it contributes nothing to `ORDER BY`. Rows would emerge ordered by `available_at`, not by `priority`, and the planner would fall back to a temporary B-tree sort — precisely the cost the index was meant to avoid.

**Correct shape:** `CREATE INDEX idx_jobs_claim ON jobs (state, priority DESC, created_at ASC, available_at)` — equality on `state` first, then the two `ORDER BY` columns in matching position and direction, with the range column last so it still filters within the already-ordered scan.

Worth noting this is already true today: `(state, available_at)` does not satisfy the current `ORDER BY created_at ASC` either. Correctness is unaffected — SQLite sorts — and it is invisible at demo scale, but the index has never been serving the ordering.

### C. Breaks semantically

**Strict priority starves low-priority work.** The subquery re-evaluates on every claim, so with `ORDER BY priority DESC` and no aging term, a continuous stream of high-priority jobs means a low-priority job is never selected — regardless of how long it has waited. FIFO fairness, which today is guaranteed by `created_at ASC`, is gone.

Mitigations both carry cost: an aging term (an effective priority that rises with wait time) or a weighted lottery would restore fairness, but a computed ordering expression cannot be served by a B-tree index, reintroducing the sort. That trade — bounded starvation versus index-satisfiable ordering — is the real design decision behind priorities here, not the column itself.

---

## Supporting decision: `failed` is the retry-waiting state

The assignment defines `failed` as "Failed, but will be retried." Putting a retryable job back in `pending` would make `list --state failed` empty and would mix "never tried" with "tried, backing off." `RetryService.handleFailure` therefore writes `state='failed'` and a future `available_at` (`JobRepository.scheduleRetry`, `:232-233`, `:227-262`).

Backoff is the assignment formula `delay_seconds = backoff-base ^ attempts` (`src/utils/backoff.ts:9-21`, called from `RetryService.ts:50-51`). Attempts were already incremented at claim (`JobRepository.ts:140`), so with default base 2 the delays are 2s, then 4s, then 8s. `claimNext` will not pick the row until `available_at <= now` (`:148-149`). Exhausted jobs (`attempts > maxRetries`) go to `dead` (`RetryService.ts:33-47` → `markDead`).

Crash recovery is a different event — the command did not fail, the worker died — so expired leases reset to `pending` (`JobRepository.ts:318`), not `failed`. `list --state failed` therefore shows backoff-waiting jobs, never crash-orphans.

---

## Supporting decision: job execution and graceful SIGINT/SIGTERM

The assignment payload is a **shell command string** (`echo Hello`, `sleep 2`, `false`). `JobExecutor` therefore uses `spawn(command, { shell: true, … })` (`src/core/JobExecutor.ts:39-45`): Node asks `/bin/sh -c` to parse redirects, `&&`, and "command not found." Exit 0 is success (`Scheduler.executeAndSettle` `:129-143`); any other exit, spawn error, or death-by-signal is failure (`JobExecutor.ts:77-85` → `RetryService`).

`detached: true` is a **process-group** decision, not a "signals cannot reach this child" claim. On Unix it makes the shell (and `sleep`) the leader of a **new** process group. Ctrl+C in a TTY, and `kill -- -<worker-pgid> SIGTERM`, deliver the signal to every process that still shares the **worker's** group. Without `detached`, `sh -c sleep 2` would get SIGTERM too, `close` would fire with `signal === 'SIGTERM'`, the job would be recorded as `failed`, and graceful shutdown would have killed the in-flight command — which violates the interface contract.

With `detached: true`, a SIGTERM/SIGINT aimed at the worker group reaches the Node process only. The child can still be killed if something signals **its** pid or pgid; we do not do that on the drain path.

The child is **not** `unref()`'d. `unref` would drop the handle from the event loop so the worker could exit while the command was still running. Keeping the handle is how `executeAndSettle` awaits `close` (`JobExecutor.ts:77-92`), then `markCompleted` on exit 0 (`Scheduler.ts:129-135`).

Drain sequence on SIGINT/SIGTERM:

1. `onShutdown` (`signals.ts:11-12`) runs in the worker process (`worker.ts:65-69`).
2. Each scheduler sets `stopping = true` (`Scheduler.requestShutdown` `:34-42`).
3. The current `await executeAndSettle` (`:88`) keeps waiting on the child.
4. On exit 0 the job becomes `completed`. The loop condition `while (!this.stopping)` (`:56`) then fails, so the next queued job is **not** claimed (`claimNext` is `:67`, after the stop check at `:57`).
5. `finally` marks the worker `stopped` (`:91-97`). `Promise.all` at `worker.ts:71` resolves, the recovery timer stops (`:78`), the DB closes (`:80`), the process exits 0.

That is the opposite of SIGKILL. SIGKILL is not registered (`signals.ts` handles only SIGINT/SIGTERM), no handler runs, `markCompleted` never runs, and the row stays `processing` until the lease expires (Q2). Recovery then re-executes the command. Combined with the orphaned detached child, that is why the system is at-least-once under crash, and why graceful shutdown can still finish the in-flight job.

---

## Supporting decision: JSON stdout, config, and `--count`

**JSON.** The assignment's seven job fields are `id`, `command`, `state`, `attempts`, `max_retries`, `created_at`, `updated_at`. `toJobJson` (`src/models/Job.ts:79-89`) is the only shape `enqueue`, `list --json`, and `dlq list --json` emit. `list --state X --json` writes that array and nothing else to stdout (`src/cli/list.ts:42-45`); logs go to stderr.

**Config.** `config set` persists in SQLite and is validated (`ConfigRepository.set` `:43-59`, rules in `constants.ts:36-79`): integers where required (`max-retries` rejects `2.5`), ranges, unknown keys rejected, and `lease-timeout-ms >= 2 × heartbeat-interval-ms`. `max_retries` is snapshotted onto the job at enqueue (`JobRepository.ts:70`); later `config set max-retries` does not rewrite existing rows. `backoff-base` is read at failure time (`RetryService.ts:50`), so a backoff change applies to the next retry of an already-enqueued job.

**`--count N` vs two terminals.** `--count 2` is two `Scheduler` instances in **one** OS process, one SQLite connection (`worker.ts:31`, `:50-61`, `:71`). Multi-process concurrency is `queuectl worker start` in two terminals. Q1's file lock is what makes that second case safe. Automated scenario 3 needs the two-process form.

---

## Stack and persistence

| Decision | Choice |
|---|---|
| Language | TypeScript (strict) |
| Database | SQLite + `better-sqlite3` v11.10.0, WAL |
| CLI | Commander.js |
| Tests | Vitest |

SQLite is the lock, the queue, and the persistence layer. A file-based JSON store cannot make `claimNext` atomic across two OS processes without a second locking protocol; SQLite's `BEGIN IMMEDIATE` already is that protocol (Q1). WAL (`database.ts:21`) keeps `list`/`status` from blocking the claim writer. The path is `QUEUECTL_DB` or `./data/queuectl.sqlite` (`database.ts:10-14`). Jobs, config, and the DLQ are rows in that file, so they survive a full process restart (scenario 5).

- Existing jobs keep their snapshotted `max_retries` (`JobRepository.ts:70`); `config set max-retries` applies to newly enqueued jobs only. `backoff-base` is read at failure time (`RetryService.ts:50`).

## Known limitations (intentional)

- Recovery requires a live worker **process**. With every worker killed, detection waits for the next `queuectl worker start` (immediate `RecoveryRunner` tick at `:36`, before any claim) or `queuectl status` (`src/cli/status.ts:27`). A standalone recovery daemon would close this, at the cost of a process to supervise. Out of scope for a foreground CLI worker.
- Crash recovery is **at-least-once**. The in-flight shell child is spawned `detached` and is not reaped when the worker is SIGKILLed (`JobExecutor.ts:39-45`). Recovery resets the row to `pending` and another worker may run the same command while the orphan is still executing. There is no portable, SIGKILL-safe way for a dead process to reap or wait for that child. Commands should be idempotent.
- `--count N` is N schedulers in one process, not N OS processes. Multi-process tests must start `worker start` more than once.
