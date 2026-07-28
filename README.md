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

> **TODO:** Replace this with your uploaded demo URL (YouTube / Google Drive / Loom).
>
> Demo link: _<add recording URL before submission>_
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

```mermaid
flowchart TB
  Start([worker start]) --> Reg[Register active]
  Reg --> HB[Heartbeat loop]
  HB --> Rec[Recover expired leases]
  Rec --> Claim{Claim pending job?}
  Claim -->|no| Idle[Sleep]
  Idle --> Rec
  Claim -->|yes| Run[Execute command]
  Run --> Ok{Success?}
  Ok -->|yes| Done[completed]
  Done --> Rec
  Ok -->|no| Retry{Retries left?}
  Retry -->|yes| Backoff["pending + base^attempts"]
  Backoff --> Rec
  Retry -->|no| Dead[dead DLQ]
  Dead --> Rec
```

## Job State Machine

```mermaid
stateDiagram-v2
  [*] --> pending: enqueue
  pending --> processing: atomic claim
  processing --> completed: success
  processing --> pending: retry with backoff
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
  Delay --> Pending[state=pending]
  Pending --> Later[Claim again when due]
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
  participant RS as RecoveryService
  participant WB as WorkerB

  WA->>DB: claim + lease_until
  Note over WA: SIGKILL
  Note over DB: lease expires ~30s
  WB->>RS: recoverExpiredLeases
  RS->>DB: processing to pending
  WB->>DB: claim again
  WB->>DB: completed
```

Look for stderr: `Job Claimed` → `Stale Job Recovered` → `Job Claimed` → `Job Completed`.

Default worst case: **~30 seconds** (`lease-timeout-ms=30000`), under the 60s assignment maximum.

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
  A->>DB: UPDATE pending to processing RETURNING
  A->>DB: COMMIT
  B->>DB: BEGIN IMMEDIATE
  B->>DB: no row left to claim
```

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `max-retries` | `3` | Retry budget snapshotted onto each job at enqueue |
| `backoff-base` | `2` | Seconds delay = `base ^ attempts` |
| `lease-timeout-ms` | `30000` | Job lease / crash recovery window (~30s worst case) |
| `heartbeat-interval-ms` | `5000` | Worker + lease heartbeat cadence |
| `poll-interval-ms` | `1000` | Idle poll sleep |

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

## Assumptions

- Single-machine deployment sharing one SQLite file (not a multi-region cluster).
- Job payloads are shell command strings executed with `shell: true`.
- Operators trust the host; there is no command sandbox or auth layer.
- Demo recording is provided separately via the Demo link above.
- Automated graders parse `list --json` from **stdout only**; logs go to stderr.

## Limitations

- SQLite write lock limits multi-worker throughput (by design for this assignment).
- Crash recovery is **at-least-once**: a job may run again after SIGKILL.
- `worker stop` is cooperative (DB flag), not instant remote kill.
- Automatic retries use `pending` + `available_at` rather than parking in `failed` (see DECISIONS.md).
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
