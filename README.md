# QueueCTL

Production-inspired CLI background job queue for Node.js.

A miniature of Sidekiq / BullMQ / Celery / SQS workers — durable SQLite storage, multi-worker atomic claiming, retries, dead-letter queue, lease-based crash recovery, and graceful shutdown.

## Features

- Job queue with shell-command payloads
- Multiple concurrent worker processes
- Atomic job claiming (`BEGIN IMMEDIATE`)
- SQLite persistence (WAL mode)
- Exponential backoff retries
- Dead letter queue + operator retry
- Lease-based crash recovery (< 60s worst case)
- Worker heartbeats + lease extension
- Graceful SIGINT/SIGTERM shutdown
- Cooperative `worker stop`
- Persistent configuration
- Status / list / DLQ commands

## Quick Start

```bash
npm install
npm run queuectl -- --help

# Enqueue work
npm run queuectl -- enqueue -- echo "hello from QueueCTL"

# Start a worker (separate terminal)
npm run queuectl -- worker start

# Inspect
npm run queuectl -- status
npm run queuectl -- list
```

Build / global-style usage:

```bash
npm run build
node dist/index.js --help
```

Database path defaults to `./data/queuectl.sqlite`. Override with `QUEUECTL_DB`.

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

Dependency rule: CLI → core → repositories → database. See [docs/architecture.md](./docs/architecture.md) and [DECISIONS.md](./DECISIONS.md).

## Database Schema

### `jobs`

| Column | Purpose |
|---|---|
| `id` | UUID |
| `command` | JSON argv array |
| `status` | pending / scheduled / running / completed / failed / dead |
| `attempts` / `max_retries` | retry bookkeeping |
| `available_at` | delay gate for scheduled retries |
| `worker_id` / `lease_until` | lease ownership |
| `stdout` / `stderr` / `exit_code` / `last_error` | execution outcome |
| timestamps | created / updated / started / finished |

### `workers`

Worker identity, pid, status (`active|stopping|stopped`), heartbeat timestamps.

### `config`

Key/value durable settings (seeded on first open).

### `job_history`

Append-only audit events (enqueued, claimed, completed, retry_scheduled, dead, recovered, requeued).

## Worker Lifecycle

```text
start → register → heartbeat loop
                 → recover expired leases
                 → claim job (atomic)
                 → execute command
                 → complete | schedule retry | dead
                 → repeat
SIGINT/SIGTERM/stop → finish current job → mark stopped
```

## Retry Flow

```text
failure
  ├─ attempts <= max_retries → status=scheduled, available_at=now+backoff
  └─ attempts >  max_retries → status=dead (DLQ)
```

Backoff: `backoff_base_ms * 2^(attempts - 1)`.

## Crash Recovery

1. Worker claims job and sets `lease_until`
2. Heartbeats extend the lease while running
3. If the process is killed, heartbeats stop
4. Another worker (or the next poll) recovers rows where `status=running AND lease_until < now`
5. Job returns to `pending` for re-execution

Defaults: `lease_timeout_ms=30000`, poll every `1000ms` → worst-case recovery < 60s.

## CLI Reference

```text
queuectl enqueue -- <command> [args...]
queuectl worker start [--id <id>]
queuectl worker stop <worker_id>
queuectl status
queuectl list [--status <status>] [--limit N]
queuectl dlq list [--limit N]
queuectl dlq retry <job_id>
queuectl dlq retry --all
queuectl config get [key]
queuectl config set <key> <value>
```

### Configuration Keys

| Key | Default | Meaning |
|---|---|---|
| `max_retries` | `3` | Retries allowed after claim failures |
| `backoff_base_ms` | `1000` | Base exponential backoff |
| `lease_timeout_ms` | `30000` | Job lease duration |
| `heartbeat_interval_ms` | `5000` | Worker/job heartbeat cadence |
| `poll_interval_ms` | `1000` | Idle poll sleep |
| `output_truncate_bytes` | `8192` | Max stored stdout/stderr |
| `shutdown_grace_ms` | `10000` | Reserved for future forced-kill grace |

## Usage Examples

```bash
# Enqueue a few jobs
npm run queuectl -- enqueue -- echo job-1
npm run queuectl -- enqueue -- sh -c "echo fail; exit 1"
npm run queuectl -- enqueue -- sleep 2

# Run two workers
npm run queuectl -- worker start &
npm run queuectl -- worker start &

# Watch queue
npm run queuectl -- status
npm run queuectl -- list --status completed

# Tune retries
npm run queuectl -- config set max_retries 1
npm run queuectl -- config set backoff_base_ms 500

# Dead letter ops
npm run queuectl -- dlq list
npm run queuectl -- dlq retry --all

# Cooperative stop
npm run queuectl -- status   # copy worker id
npm run queuectl -- worker stop <worker_id>
```

## Testing

```bash
npm test
npm run typecheck
```

Coverage focuses on production-risk paths: atomic claim, backoff, retry/DLQ transition, lease recovery, and stop cooperation.

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

## Engineering Notes

QueueCTL is built for **interview-ready clarity**: small modules, repository/service boundaries, configuration-driven timeouts, and explicit recovery semantics. See [DECISIONS.md](./DECISIONS.md) for the full rationale.
