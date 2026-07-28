# QueueCTL Engineering Decisions

## Stack

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict) | Type-safe CLI without framework bloat |
| Runtime | Node.js >= 20 | ESM, `child_process`, `crypto.randomUUID` |
| Database | SQLite via `better-sqlite3` | Zero ops; synchronous API for atomic claims |
| CLI | Commander.js | kubectl/docker-style subcommands |
| Tests | Vitest | Fast Node TypeScript tests |

## Architecture

Layers: **CLI → Services → Repositories → SQLite**.

CLI owns argv/exit codes only. Services own claim/retry/DLQ/recovery rules. Repositories own SQL.

## Why JSON enqueue?

The assignment contract is:

```bash
queuectl enqueue '{"id":"job1","command":"echo Hello QueueCTL"}'
```

The CLI parses JSON, stores `command` as a shell string, and honors the provided `id`. Generating a UUID and treating the whole JSON blob as the command would break automated graders.

## Job states

Assignment states only:

`pending | processing | completed | failed | dead`

- `processing` is the claimed/in-flight state (not `running`)
- Delayed retries stay `pending` with a future `available_at` (no separate `scheduled` state)

## Backoff formula

Assignment: `delay = base ^ attempts` (seconds).

With `backoff-base=2`:

| attempts | delay |
|---|---|
| 1 | 2s |
| 2 | 4s |
| 3 | 8s |

Implemented in `utils/backoff.ts` as `base ** attempts`, converted to ms for `available_at`.

## Atomic claim

`JobRepository.claimNext()` uses `db.transaction(...).immediate()` (`BEGIN IMMEDIATE`) plus:

```sql
UPDATE jobs SET state='processing', ... WHERE id = (
  SELECT id FROM jobs
  WHERE state='pending' AND available_at <= ?
  ORDER BY created_at ASC LIMIT 1
) RETURNING *
```

Two OS processes cannot claim the same row because SQLite serializes writers on the IMMEDIATE write lock.

## Crash recovery

Exact timeline (interview proof path):

1. **Worker claims job** — atomic `BEGIN IMMEDIATE` claim sets `state=processing`, `worker_id`, and `lease_until = now + lease-timeout-ms`.
2. **Lease written to database** — ownership is durable; heartbeats extend `lease_until` while work runs.
3. **Worker crashes (`SIGKILL`)** — no graceful `markStopped`; in-flight cleanup never runs.
4. **Lease expires** — wall clock passes `lease_until` with no heartbeat extension.
5. **RecoveryService resets job to `pending`** — clears `worker_id` / `lease_until`, logs `Stale Job Recovered` with previous owner + lease.
6. **Another worker atomically claims it** — same claim path; `attempts` increments; new lease written.
7. **Job completes** — survivor executes command and marks `completed`.

**Worst-case recovery time:** default `lease-timeout-ms=30000` (30 seconds). With poll recovery each loop, reclaim happens shortly after expiry — **under the assignment's 60-second maximum**.

Observability logs for this path:

- `Job Claimed` — `job_id`, `worker_id`, `pid`, `attempt`, `lease_until`
- `Stale Job Recovered` — `job_id`, `previous_worker`, `previous_lease_until`, `recovered_at`, `reason=lease_expired`
- `Job Completed` — `job_id`, `worker_id`, `attempt`, `duration_ms`, `exit_code`

### Stale worker rows (zombies)

Job recovery and worker-row cleanup are separate:

- **Jobs** are reclaimed via expired `lease_until` (source of truth for work)
- **Workers** left `active` after SIGKILL are marked `stopped` when
  `last_heartbeat_at` is older than `max(lease-timeout-ms, heartbeat-interval-ms * 3)`

Without worker cleanup, `queuectl status` would report days-old zombies as active.
That is a display/ops bug — it does not block job reclaim. Cleanup runs on the
worker poll loop and on `status` so operators always see truthful liveness.

## Worker start / stop

- `worker start` runs in the **foreground**
- `--count N` registers N worker loops in one process (`Promise.all`)
- Ctrl+C / SIGTERM: stop claiming, finish in-flight job, mark workers stopped
- `worker stop` (no ID): sets **all** `active|stopping` workers to `stopping` in SQLite; running processes observe this on poll/heartbeat and drain gracefully

Mechanism: cooperative DB flag — not remote SIGKILL.

## Configuration persistence

`config set max-retries` / `config set backoff-base` write to the `config` table and survive restarts.

**Existing jobs do not inherit new `max-retries`.** Each job snapshots `max_retries` at enqueue time (or from JSON). `backoff-base` is read at failure time, so backoff base changes apply to future retries of already-enqueued jobs.

## JSON stdout contract

`list --state … --json` writes only `JSON.stringify(array) + newline` to stdout. Logger uses stderr so graders parsing stdout see a pure JSON array.

## Persistence

SQLite file (`QUEUECTL_DB` or `./data/queuectl.sqlite`) survives worker restart, CLI restart, and full process restart. WAL mode is enabled for concurrent readers/writers.

## Deliberate non-goals

- Web dashboard
- Exactly-once side effects (at-least-once after crash recovery)
- Remote SIGKILL from `worker stop`
