# QueueCTL Engineering Decisions

This document records why QueueCTL is built the way it is.

## Stack

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict) | Interview-ready type safety without framework bloat |
| Runtime | Node.js >= 20 | Modern ESM, stable `child_process`, native `crypto.randomUUID` |
| Database | SQLite via `better-sqlite3` | Zero ops, durable, synchronous API ideal for claim transactions |
| CLI | Commander.js | Familiar subcommand UX (kubectl / docker style) |
| Package manager | npm | Widest review familiarity |
| Tests | Vitest | Fast Node test runner, simple TypeScript DX |

## Architecture

Layered clean architecture:

1. **CLI** — parse args, format output, exit codes
2. **Services** — business rules (claim, retry, DLQ, recovery)
3. **Repositories** — SQL only
4. **Database** — connection, migrations, schema

Dependency direction is always inward: CLI → core → repositories → database.

### Why not put SQL in services?

Services should remain readable during a live review. SQL details (especially claim/recovery) belong behind a repository boundary so invariants can be tested independently.

### Why not an Express dashboard in v1?

The product goal is a DevOps CLI. A dashboard is optional sugar and would expand scope without teaching the queue fundamentals.

## Persistence & Concurrency

### WAL mode

WAL allows concurrent readers while a writer holds the write lock — important when many CLI commands inspect status while workers claim jobs.

### `BEGIN IMMEDIATE` for claims

SQLite's default `BEGIN DEFERRED` can allow two transactions to start before either upgrades to a write lock, creating busy/retry races. `transaction().immediate()` acquires the write lock up front so only one claim mutation proceeds.

Claim SQL selects the oldest available job inside the `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *` pattern. This is a single atomic statement under the immediate transaction.

### Why leases instead of only worker heartbeats?

A worker heartbeat proves the process is alive, but jobs need their own deadline. Leases decouple "worker alive" from "this job is still owned", and make recovery correct even if a worker row is stale.

Default `lease_timeout_ms=30000` plus frequent poll/recovery keeps worst-case stranded work under 60 seconds.

## Retry Semantics

- `attempts` increments at **claim** time (not enqueue)
- Failure handler compares `attempts > max_retries`
- With `max_retries=3`, a job may execute up to 4 times (initial + 3 retries)
- Backoff is pure (`utils/backoff.ts`) and unit-tested: `base * 2^(attempt-1)`

### Why snapshot `max_retries` on the job row?

Changing global config must not mutate the retry budget of already-enqueued jobs. Snapshotting keeps behavior predictable.

## Dead Letter Queue

Exhausted jobs become `dead` rather than deleted. Operators can inspect `last_error` / output and requeue deliberately (`dlq retry`). This matches production queue systems where silent discard is unacceptable.

## Worker Process Model

One OS process per worker. Horizontal concurrency is "run more processes", not in-process thread pools. This mirrors Sidekiq/Celery worker processes and keeps crash isolation clear.

### Graceful shutdown

SIGINT/SIGTERM set an in-memory stop flag. The loop stops claiming new work, finishes the current child process, then marks the worker `stopped`.

### Cooperative stop command

`worker stop <id>` sets `workers.status='stopping'`. The running loop observes this on poll/heartbeat. We intentionally do **not** remote-SIGKILL from the CLI — that would bypass graceful drain and is unsafe as a default.

### SIGKILL recovery

SIGKILL cannot be handled. Lease expiry is the safety net.

## Logging

Logs go to stderr (so stdout stays clean for machine-readable IDs where useful) and include stable event phrases:

- Worker Started / Stopped
- Job Claimed / Completed
- Retry Scheduled / Job Dead
- Recovery Executed

Human-readable key=value metadata keeps demos and incident debugging simple without a full structured-log stack.

## Configuration

All timing/retry knobs live in the `config` table with code defaults in `utils/constants.ts`. Hot paths read via `ConfigRepository` — no magic numbers scattered through services.

## Output Truncation

Command stdout/stderr are truncated to `output_truncate_bytes` before persistence to protect SQLite from multi-megabyte log spam.

## Testing Strategy

Prefer focused tests on failure modes that matter in production:

- claim exclusivity
- backoff math
- retry → scheduled / dead transitions
- expired lease recovery
- stop cooperation

End-to-end shell demos remain manual via the CLI.

## Deliberate Non-Goals (v1)

- Priority queues / delayed job APIs beyond retry scheduling
- Distributed multi-host locking beyond a shared SQLite file
- Web dashboard
- Exactly-once side effects (at-least-once after crash recovery is the contract)
- Sandboxed command execution / security policy engine

These can be layered later without rewriting the core lease/claim model.
