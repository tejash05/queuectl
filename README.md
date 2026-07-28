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

## Demo recording

> Demo link: [QueuectlDemo.mov](https://drive.google.com/file/d/1odrKU852VPRJ4wwHndpkHI0OAORquIyB/view?usp=sharing)
>
> Suggested demo script: enqueue → `worker start --count 2` → `status` / `list --json` → Ctrl+C drain → `kill -9` recovery (`Stale Job Recovered` log) → `dlq` / `config set`.

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
- Concurrent workers via `--count` (same OS process) or separate `worker start` terminals (separate OS processes)
- Atomic job claiming (`BEGIN IMMEDIATE`)
- SQLite persistence (WAL mode)
- Exponential backoff: `delay_seconds = backoff-base ^ attempts`
- Dead letter queue + operator retry
- Lease-based crash recovery on an independent timer (~35s at defaults, measured 34.6s)
- Worker heartbeats + lease extension
- Graceful SIGINT/SIGTERM shutdown
- Cooperative `worker stop` from another terminal
- Persistent configuration

## Architecture

Layered clean architecture. Deep-dive diagrams (crash recovery sequence, atomic claim contention, full ER, folder map) live in [docs/architecture.md](./docs/architecture.md).

```mermaid
flowchart TB
  subgraph cliLayer [CLI Layer]
    direction LR
    EnqueueCmd[enqueue]
    WorkerCmd[worker]
    StatusCmd[status]
    ListCmd[list]
    DlqCmd[dlq]
    ConfigCmd[config]
  end

  subgraph appLayer [Application Layer]
    JobService[JobService]
    WorkerService[WorkerService]
    RetryService[RetryService]
    RecoveryService[RecoveryService]
    Scheduler[Scheduler]
    JobExecutor[JobExecutor]
  end

  subgraph repoLayer [Repository Layer]
    JobRepo[JobRepository]
    WorkerRepo[WorkerRepository]
    ConfigRepo[ConfigRepository]
  end

  subgraph dbLayer [SQLite WAL]
    JobsTable[(jobs)]
    WorkersTable[(workers)]
    ConfigTable[(config)]
  end

  EnqueueCmd --> JobService
  WorkerCmd --> Scheduler
  WorkerCmd --> WorkerService
  StatusCmd --> JobService
  StatusCmd --> WorkerService
  ListCmd --> JobService
  DlqCmd --> JobService
  ConfigCmd --> ConfigRepo

  JobService --> JobRepo
  WorkerService --> WorkerRepo
  RetryService --> JobRepo
  RecoveryService --> JobRepo
  Scheduler --> RecoveryService
  Scheduler --> JobRepo
  Scheduler --> JobExecutor
  Scheduler --> RetryService

  JobRepo --> JobsTable
  WorkerRepo --> WorkersTable
  ConfigRepo --> ConfigTable
```

### Request flow

```mermaid
flowchart LR
  Op([Operator]) -->|enqueue JSON| CLI[CLI]
  CLI --> JS[JobService]
  JS --> JR[JobRepository]
  JR -->|INSERT pending| DB[(SQLite)]
  W([Worker]) -->|claim BEGIN IMMEDIATE| DB
  W -->|execute| EX[JobExecutor]
  EX -->|complete or retry/DLQ| DB
  Op2([Operator]) -->|status list --json| CLI2[CLI reads]
  CLI2 --> DB
```

See [DECISIONS.md](./DECISIONS.md) for claim, lease recovery, and stop-design rationale.

## Database Schema

```mermaid
erDiagram
  WORKERS ||--o{ JOBS : claims
  JOBS ||--o{ JOB_HISTORY : audits

  JOBS {
    text id PK
    text command
    text state
    int attempts
    int max_retries
    text available_at
    text worker_id FK
    text lease_until
  }

  WORKERS {
    text id PK
    text hostname
    int pid
    text status
    text last_heartbeat_at
  }

  CONFIG {
    text key PK
    text value
  }
```

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

The recovery timer is a sibling of the scheduler loop, not a step inside it.

```mermaid
flowchart TB
  Start([worker start]) --> Runner[Start RecoveryRunner timer]
  Start --> Reg[Register active]
  Reg --> HB[Heartbeat loop]
  HB --> Claim{Claim pending or due failed job?}
  Claim -->|no| Idle[Sleep]
  Idle --> Claim
  Claim -->|yes| Run[Execute command]
  Run --> Ok{Success?}
  Ok -->|yes| Done[completed]
  Done --> Claim
  Ok -->|no| Retry{Retries left?}
  Retry -->|yes| Backoff["failed + base^attempts"]
  Backoff --> Claim
  Retry -->|no| Dead[dead DLQ]
  Dead --> Claim
  Runner --> Rec[recoverExpiredLeases every 5s]
  Rec --> Rec
```

## Job State Machine

```mermaid
stateDiagram-v2
  [*] --> pending: enqueue
  pending --> processing: atomic claim
  failed --> processing: backoff expired, atomic claim
  processing --> completed: success
  processing --> failed: retryable failure + backoff
  processing --> pending: lease recovery after SIGKILL
  processing --> dead: max retries exceeded
  dead --> pending: dlq retry
  completed --> [*]
  dead --> [*]
```

## Retry Flow

```mermaid
flowchart TB
  Fail[Command failed] --> Check{attempts > max_retries?}
  Check -->|no| Delay["available_at = now + base^attempts"]
  Delay --> Failed[state=failed]
  Failed --> Later[Claim again when due]
  Check -->|yes| DLQ[state=dead]
  DLQ --> Manual[dlq retry resets attempts]
```

Example with `backoff-base=2`: attempt 1 → 2s, attempt 2 → 4s, attempt 3 → 8s.

Existing jobs keep their snapshotted `max_retries`. New `config set max-retries` applies to newly enqueued jobs only (unless the enqueue JSON overrides `max_retries`).

## Crash Recovery

```mermaid
sequenceDiagram
  participant WA as WorkerA
  participant DB as SQLite
  participant RR as RecoveryRunner (WorkerB timer)
  participant WB as WorkerB scheduler

  WA->>DB: claim + lease_until
  Note over WA: SIGKILL
  Note over DB: lease expires after ~30s
  Note over WB: may be busy with its own long job
  RR->>DB: recoverExpiredLeases (every 5s, independent of WB job)
  RR->>DB: processing to pending
  WB->>DB: claim again (once free)
  WB->>DB: completed
```

Look for stderr: `Job Claimed` → `Stale Job Recovered` → `Job Claimed` → `Job Completed`.

Recovery runs on `RecoveryRunner`'s own timer (`src/core/RecoveryRunner.ts`), one per worker
process, **not** inside the scheduler's claim/execute loop. That is what lets a worker
reclaim a crashed peer's job while it is itself executing a long-running command.

**Detection time** (SIGKILL → job back in `pending`) is bounded by lease expiry plus one
recovery interval: `lease-timeout-ms` (30s) + `recovery-interval-ms` (5s) ≈ **35s** at
defaults, inside the assignment's 60s limit. Measured end-to-end at defaults: **34.6s**,
with the surviving worker 35s into a 90s job.

This bound holds **while at least one worker process is alive**. If every worker is killed
there is no process left to detect the expired lease; the job is recovered as soon as an
operator runs `queuectl worker start` (which recovers immediately on startup) or
`queuectl status`. Re-execution is additionally gated on a free worker, so a job may sit in
`pending` after recovery until some scheduler finishes its current work.

Covered by `tests/crashRecoveryWhilePeerBusy.test.ts` (real processes, real `SIGKILL`,
reports the measured recovery time) and `tests/recoveryRunner.test.ts`.

## Worker Stop

```mermaid
sequenceDiagram
  participant CLI as queuectl worker stop
  participant DB as SQLite
  participant S as Scheduler

  CLI->>DB: status=stopping
  S->>DB: observe stopping
  S->>S: finish current job
  S->>DB: status=stopped
```

## Atomic Claim

```mermaid
sequenceDiagram
  participant A as WorkerA
  participant DB as SQLite
  participant B as WorkerB

  A->>DB: BEGIN IMMEDIATE
  B-->>DB: waits for write lock
  A->>DB: UPDATE pending/failed to processing RETURNING
  A->>DB: COMMIT
  B->>DB: BEGIN IMMEDIATE
  B->>DB: no row left to claim
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `max-retries` | `3` | Retry budget snapshotted onto each job at enqueue |
| `backoff-base` | `2` | Seconds delay = `base ^ attempts` |
| `lease-timeout-ms` | `30000` | Job lease; a lease this stale means the owner died |
| `heartbeat-interval-ms` | `5000` | Worker + lease heartbeat cadence |
| `recovery-interval-ms` | `5000` | Independent recovery timer; detection ≈ lease + this |
| `poll-interval-ms` | `1000` | Idle poll sleep |
| `output-truncate-bytes` | `8192` | Captured stdout/stderr cap per job |

```bash
queuectl config set max-retries 3
queuectl config set backoff-base 2
queuectl config get
```

## Testing

```bash
npm test
npm run typecheck
```

`npm test` includes black-box CLI tests that spawn real `queuectl worker start` processes
and send `SIGKILL`. Those tests need permission to manage process groups (they fail under
a tight sandbox with a timeout waiting for a worker to claim a job).

## Assumptions

- Single-machine deployment sharing one SQLite file (not a multi-region cluster).
- Job payloads are shell command strings executed with `shell: true`.
- Operators trust the host; there is no command sandbox or auth layer.
- Demo recording is provided separately via the Demo link above.
- Automated graders parse `list --json` from **stdout only**; logs go to stderr.

## Limitations

- SQLite write lock limits multi-worker throughput (by design for this assignment).
- Crash recovery is **at-least-once**: a job may run again after SIGKILL. Commands should be
  idempotent — a killed worker's child process is not itself reaped by QueueCTL, so work
  already performed before the crash is not undone. A bare `kill -9 <pid>` orphans the
  shell child; `kill -- -<pgid>` reaps the group.
- Recovery requires a live worker process. With every worker dead, detection waits for the
  next `worker start` or `status`; there is no standalone recovery daemon by design.
- `worker stop` is cooperative (DB flag), not instant remote kill.
- Automatic retries park in `failed` with a future `available_at` (the assignment's
  "failed, but will be retried" state). Crash recovery resets to `pending`, not `failed`,
  because a SIGKILL is not a command failure.
- Not a distributed queue; Redis/NATS would be needed for multi-host workers.
- No web dashboard in this submission.

## Project Structure

```mermaid
flowchart TB
  subgraph repo [queuectl]
    README[README.md]
    DECISIONS[DECISIONS.md]
    subgraph src [src]
      cli[cli]
      core[core services]
      repositories[repositories]
      database[database]
      models[models]
      utils[utils]
      index[index.ts]
    end
    tests[tests]
    docs[docs]
    data[data]
  end
```

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
