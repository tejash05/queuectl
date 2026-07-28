# QueueCTL Architecture

Deep-dive diagrams for interview and code review. High-level overview also lives in [README.md](../README.md).

---

## 1. Layered System Architecture

```mermaid
flowchart TB
  subgraph cliLayer [CLI Layer]
    direction LR
    EnqueueCmd[enqueue]
    WorkerCmd[worker start/stop]
    StatusCmd[status]
    ListCmd[list]
    DlqCmd[dlq]
    ConfigCmd[config]
  end

  subgraph appLayer [Application Layer]
    direction TB
    JobService[JobService]
    WorkerService[WorkerService]
    RetryService[RetryService]
    RecoveryService[RecoveryService]
    Scheduler[Scheduler]
    JobExecutor[JobExecutor]
  end

  subgraph repoLayer [Repository Layer]
    direction LR
    JobRepo[JobRepository]
    WorkerRepo[WorkerRepository]
    ConfigRepo[ConfigRepository]
  end

  subgraph dbLayer [SQLite WAL]
    direction LR
    JobsTable[(jobs)]
    WorkersTable[(workers)]
    ConfigTable[(config)]
    HistoryTable[(job_history)]
  end

  EnqueueCmd -->|write job JSON| JobService
  WorkerCmd -->|register and poll| WorkerService
  WorkerCmd --> Scheduler
  StatusCmd -->|read aggregates| JobService
  StatusCmd --> WorkerService
  ListCmd -->|query by state| JobService
  DlqCmd -->|list or requeue| JobService
  ConfigCmd -->|get/set| ConfigRepo

  JobService --> JobRepo
  WorkerService --> WorkerRepo
  RetryService --> JobRepo
  RetryService --> ConfigRepo
  RecoveryService --> JobRepo
  RecoveryService --> WorkerRepo
  Scheduler --> JobRepo
  Scheduler --> WorkerService
  Scheduler --> RecoveryService
  Scheduler --> RetryService
  Scheduler --> JobExecutor
  Scheduler --> ConfigRepo

  JobRepo -->|INSERT UPDATE SELECT| JobsTable
  JobRepo --> HistoryTable
  WorkerRepo -->|INSERT UPDATE SELECT| WorkersTable
  ConfigRepo -->|UPSERT SELECT| ConfigTable
```

Dependency rule: CLI → Application → Repository → Database. SQL never leaves the repository layer.

---

## 2. End-to-End Request Flow

```mermaid
flowchart LR
  Operator([Operator]) -->|queuectl enqueue| CliParser[CLI Parser]
  CliParser -->|JobService.enqueueFromJson| JobServiceNode[JobService]
  JobServiceNode -->|JobRepository.create| JobRepoNode[JobRepository]
  JobRepoNode -->|INSERT pending| SqliteNode[(SQLite WAL)]

  WorkerProc([Worker Process]) -->|Scheduler.poll| ClaimPath[claimNext BEGIN IMMEDIATE]
  ClaimPath -->|UPDATE processing| SqliteNode
  ClaimPath -->|JobExecutor.execute| Shell[shell command]
  Shell -->|exit 0| CompletePath[markCompleted]
  Shell -->|exit non-zero| RetryPath[RetryService]
  RetryPath -->|pending plus available_at or dead| SqliteNode
  CompletePath --> SqliteNode

  Operator2([Operator]) -->|queuectl status / list --json| ReadPath[JobService / WorkerService]
  ReadPath --> SqliteNode
```

---

## 3. Worker Lifecycle

```mermaid
flowchart TB
  Start([worker start]) --> Register[Register worker row status=active]
  Register --> Heartbeat[Start heartbeat timer]
  Heartbeat --> Recover[RecoveryService.recover]
  Recover --> Claim{Atomic claim pending job?}

  Claim -->|no| Idle[Sleep poll-interval-ms]
  Idle --> StopCheck{stopping or SIGINT?}
  StopCheck -->|no| Recover
  StopCheck -->|yes| Drain[Finish in-flight if any]
  Drain --> MarkStopped[Mark worker stopped]
  MarkStopped --> Exit([Process exit])

  Claim -->|yes| Execute[JobExecutor shell spawn]
  Execute --> Success{exit_code == 0?}

  Success -->|yes| Complete[state=completed]
  Complete --> Recover

  Success -->|no| RetryCheck{attempts <= max_retries?}
  RetryCheck -->|yes| Backoff[delay = base^attempts seconds]
  Backoff --> PendingDelay[state=pending available_at=now+delay]
  PendingDelay --> Recover

  RetryCheck -->|no| Dead[state=dead DLQ]
  Dead --> Recover
```

---

## 4. Job State Machine

```mermaid
stateDiagram-v2
  [*] --> pending: enqueue

  pending --> processing: atomic claim
  processing --> completed: exit_code 0
  processing --> pending: failure with retries left\navailable_at = now + base^attempts
  processing --> dead: attempts > max_retries
  processing --> pending: lease expired\nRecoveryService reclaim
  processing --> failed: markFailed terminal path

  dead --> pending: dlq retry\nattempts reset to 0

  completed --> [*]
  failed --> [*]
  dead --> [*]
```

Notes:
- Automatic retries park in `pending` with a future `available_at` (not a separate scheduled state).
- `failed` remains a valid terminal state; the default retry path does not use it as an intermediate.

---

## 5. Crash Recovery Sequence

```mermaid
sequenceDiagram
  participant WA as WorkerA
  participant DB as SQLite
  participant RS as RecoveryService
  participant WB as WorkerB

  WA->>DB: BEGIN IMMEDIATE claim job
  DB-->>WA: state=processing lease_until=now+30s
  loop Heartbeat every 5s
    WA->>DB: extend lease_until refresh worker heartbeat
  end
  Note over WA: SIGKILL - no cleanup runs
  Note over DB: heartbeats stop lease_until freezes
  Note over DB: wall clock passes lease_until
  WB->>RS: poll recoverExpiredLeases
  RS->>DB: SELECT processing where lease_until < now
  RS->>DB: UPDATE state=pending clear worker_id lease
  RS-->>WB: Stale Job Recovered log
  WB->>DB: BEGIN IMMEDIATE claim job
  DB-->>WB: state=processing new lease
  WB->>WB: JobExecutor.execute
  WB->>DB: state=completed
  Note over WA,WB: Job never remains stuck forever worst case ~30s
```

---

## 6. Worker Stop Sequence

```mermaid
sequenceDiagram
  participant CLI as queuectl CLI
  participant DB as SQLite
  participant W as Worker Process
  participant S as Scheduler

  CLI->>DB: UPDATE workers SET status=stopping
  CLI-->>CLI: Stop requested for N worker(s)
  loop Poll / heartbeat
    S->>DB: SELECT worker status
    DB-->>S: status=stopping
    S->>S: requestShutdown stop_command
    Note over S: Stop claiming new jobs
    alt Job in flight
      S->>S: await current JobExecutor
      S->>DB: markCompleted or retry/dead
    end
    S->>DB: UPDATE workers SET status=stopped
    W-->>W: process exits
  end
```

---

## 7. Atomic Claim Under Contention

```mermaid
sequenceDiagram
  participant WA as WorkerA
  participant DB as SQLite WAL
  participant WB as WorkerB

  WA->>DB: BEGIN IMMEDIATE
  Note over DB: Write lock acquired by WorkerA
  WB->>DB: BEGIN IMMEDIATE
  Note over WB,DB: WorkerB blocks on write lock
  WA->>DB: UPDATE jobs SET processing WHERE id = subquery pending LIMIT 1
  DB-->>WA: RETURNING claimed row
  WA->>DB: COMMIT
  Note over DB: Write lock released
  WB->>DB: write lock granted
  WB->>DB: UPDATE jobs SET processing WHERE id = subquery pending LIMIT 1
  DB-->>WB: empty result - that job already processing
  WB->>DB: COMMIT
  Note over WA,WB: Duplicate execution impossible
```

Claim SQL (conceptual):

```sql
BEGIN IMMEDIATE;
UPDATE jobs
SET state = 'processing', worker_id = ?, lease_until = ?, attempts = attempts + 1
WHERE id = (
  SELECT id FROM jobs
  WHERE state = 'pending' AND available_at <= ?
  ORDER BY created_at ASC
  LIMIT 1
)
RETURNING *;
COMMIT;
```

---

## 8. Retry and Backoff Flow

```mermaid
flowchart TB
  Exec[Execute shell command] --> Exit{exit_code}
  Exit -->|0| Done[state=completed]
  Exit -->|non-zero| Cmp{attempts > max_retries?}

  Cmp -->|no| Calc["delay_seconds = backoff_base ^ attempts"]
  Calc --> Avail["available_at = now + delay"]
  Avail --> Pend[state=pending]
  Pend --> Wait[Worker skips until available_at]
  Wait --> ClaimAgain[Atomic claim again]
  ClaimAgain --> Exec

  Cmp -->|yes| DLQ[state=dead]
  DLQ --> Op[Operator: dlq list / dlq retry]
  Op -->|retry| Reset[attempts=0 state=pending]
  Reset --> ClaimAgain
```

Example with `backoff-base=2`: attempt 1 → 2s, attempt 2 → 4s, attempt 3 → 8s.

---

## 9. Database ER Diagram

```mermaid
erDiagram
  WORKERS ||--o{ JOBS : "claims via worker_id"
  JOBS ||--o{ JOB_HISTORY : "audits"

  JOBS {
    text id PK
    text command
    text state
    int attempts
    int max_retries
    text available_at
    text worker_id FK
    text lease_until
    text last_error
    int exit_code
    text created_at
    text updated_at
    text started_at
    text finished_at
  }

  WORKERS {
    text id PK
    text hostname
    int pid
    text status
    text last_heartbeat_at
    text started_at
    text stopped_at
  }

  CONFIG {
    text key PK
    text value
    text updated_at
  }

  JOB_HISTORY {
    int id PK
    text job_id FK
    text event
    text detail
    text created_at
  }
```

Lease and scheduling hot fields: `jobs.lease_until`, `jobs.available_at`, `jobs.attempts`, `jobs.state`, `workers.last_heartbeat_at`.

---

## 10. Project Structure

```mermaid
flowchart TB
  subgraph root [queuectl]
    direction TB
    Readme[README.md]
    Decisions[DECISIONS.md]
    Pkg[package.json]

    subgraph srcTree [src]
      Index[index.ts]
      subgraph cliTree [cli]
        Enq[enqueue.ts]
        Wrk[worker.ts]
        St[status.ts]
        Ls[list.ts]
        Dlq[dlq.ts]
        Cfg[config.ts]
      end
      subgraph coreTree [core]
        JS[JobService]
        WS[WorkerService]
        RS[RetryService]
        Rec[RecoveryService]
        Sch[Scheduler]
        Ex[JobExecutor]
      end
      subgraph repoTree [repositories]
        JR[JobRepository]
        WR[WorkerRepository]
        CR[ConfigRepository]
      end
      subgraph dbTree [database]
        Open[database.ts]
        Schema[schema.ts]
        Mig[migrations.ts]
      end
      Models[models]
      Utils[utils]
      Types[types]
    end

    Tests[tests]
    Docs[docs/architecture.md]
    Data[data/queuectl.sqlite]
  end
```

Physical layout mirrors clean architecture: CLI commands stay thin; domain rules live in `core`; SQL lives in `repositories`.
