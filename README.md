# QueueCTL

Production-inspired CLI background job queue for Node.js.

A miniature of Sidekiq / BullMQ / Celery / SQS workers — durable SQLite storage, multi-worker atomic claiming, retries, dead-letter queue, lease-based crash recovery, and graceful shutdown.

## Setup

```bash
npm install
npm run build
npm link          # exposes `queuectl` on your PATH via dist/index.js
queuectl --help
```

Local development without linking:

```bash
npm run queuectl -- --help
# or
npx tsx src/index.ts --help
```

Database path defaults to `./data/queuectl.sqlite`. Override with `QUEUECTL_DB`.

## CLI (assignment contract)

```bash
queuectl enqueue '{"id":"job1","command":"echo Hello QueueCTL"}'

queuectl worker start
queuectl worker start --count 3

queuectl worker stop

queuectl status

queuectl list --state pending
queuectl list --state pending --json

queuectl dlq list
queuectl dlq retry job1

queuectl config set max-retries 3
queuectl config set backoff-base 2
queuectl config get
```

`list --json` prints **only** a JSON array to stdout (no logs, headers, or colors). Operational logs always go to stderr.

## Features

- JSON enqueue with client-provided job IDs
- Concurrent workers via `--count`
- Atomic job claiming (`BEGIN IMMEDIATE`)
- SQLite persistence (WAL mode)
- Exponential backoff: `delay_seconds = backoff-base ^ attempts`
- Dead letter queue + operator retry
- Lease-based crash recovery (< 60s worst case with defaults)
- Worker heartbeats + lease extension
- Graceful SIGINT/SIGTERM shutdown
- Cooperative `worker stop` from another terminal
- Persistent configuration

## Architecture

```text
┌─────────────────────────────────────────────────────────┐
│ CLI: enqueue | worker | status | list | config | dlq    │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│ Services: Job / Worker / Retry / Recovery / Scheduler   │
└───────────────────────────┬─────────────────────────────┘
                            │
┌───────────────────────────▼─────────────────────────────┐
│ Repositories → SQLite (WAL) jobs | workers | config     │
└─────────────────────────────────────────────────────────┘
```

See [docs/architecture.md](./docs/architecture.md) and [DECISIONS.md](./DECISIONS.md).

## Database Schema

### `jobs`

| Column | Purpose |
|---|---|
| `id` | Client-provided or generated ID |
| `command` | Shell command string |
| `state` | pending / processing / completed / failed / dead |
| `attempts` / `max_retries` | retry bookkeeping |
| `available_at` | delay gate for retries |
| `worker_id` / `lease_until` | lease ownership |
| timestamps / output fields | audit + execution outcome |

### `workers`

Worker identity, pid, status (`active|stopping|stopped`), heartbeat timestamps.

### `config`

Key/value durable settings. Assignment keys: `max-retries`, `backoff-base`.

### `job_history`

Append-only audit events.

## Worker Lifecycle

```text
start [--count N] → register N workers → heartbeat loops
                 → recover expired leases
                 → claim job (atomic) → state=processing
                 → execute shell command
                 → completed | pending(delayed) | dead
SIGINT / worker stop → finish current job → mark stopped
```

## Retry Flow

```text
failure (attempts already incremented at claim)
  ├─ attempts <= max_retries → state=pending, available_at=now+base^attempts seconds
  └─ attempts >  max_retries → state=dead (DLQ)
```

Example with `backoff-base=2`: attempt 1 → 2s, attempt 2 → 4s, attempt 3 → 8s.

Existing jobs keep their snapshotted `max_retries`. New `config set max-retries` applies to newly enqueued jobs only (unless the enqueue JSON overrides `max_retries`).

## Crash Recovery

1. Worker claims job → `state=processing`, lease written (`lease_until`)
2. Worker crashes (`kill -9`) → no cleanup
3. Lease expires (default `lease-timeout-ms=30000` ≈ **30s**, under 60s max)
4. `RecoveryService` resets job to `pending` and logs `Stale Job Recovered`
5. Another worker claims it → executes → `completed`

Look for these stderr logs in a live demo: `Job Claimed` → `Stale Job Recovered` → `Job Claimed` (new worker) → `Job Completed`.

## Testing

```bash
npm test
npm run typecheck
```

## Project Structure

```text
src/
  cli/           # Commander commands + formatting
  core/          # Job/Worker/Retry/Recovery/Scheduler/Executor
  repositories/  # SQL access
  database/      # connection, schema, migrations
  models/        # domain types + row mappers
  utils/         # logger, backoff, signals, time, ids
  types/         # shared unions
tests/
docs/
README.md
DECISIONS.md
```
