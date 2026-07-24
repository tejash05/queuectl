# QueueCTL Architecture

## Layers

```
CLI (src/cli) → Services (src/core) → Repositories → SQLite
```

| Layer | Responsibility |
|---|---|
| CLI | argv parsing, tables/colors, exit codes |
| Services | claim/retry/DLQ/recovery/execution rules |
| Repositories | SQL + row mapping |
| Database | WAL connection, migrations, schema |

## Worker Loop

1. Register worker row (`active`)
2. Start heartbeat timer (extends job lease + updates worker heartbeat)
3. On each poll: run lease recovery → claim next job (`BEGIN IMMEDIATE`) → execute → complete or retry/dead
4. On SIGINT/SIGTERM or `worker stop`: stop claiming, finish in-flight job, mark `stopped`

## Lease Recovery

- Claim sets `lease_until = now + lease_timeout_ms`
- Heartbeat refreshes `lease_until` while job runs
- If worker dies (SIGKILL), lease expires
- Recovery sets expired `running` jobs back to `pending`

Default `lease_timeout_ms=30000` keeps worst-case recovery under 60 seconds.

## Retry / DLQ

- Attempts increment at claim time
- On failure: if `attempts > max_retries` → `dead`, else `scheduled` with exponential backoff
- Backoff: `backoff_base_ms * 2^(attempts - 1)`
- Operators requeue via `queuectl dlq retry`
