# QueueCTL Architecture

## Layers

```
CLI (src/cli) → Services (src/core) → Repositories → SQLite
```

## Worker Loop

1. Register worker row (`active`)
2. Start heartbeat timer (extends job lease + updates worker heartbeat)
3. On each poll: recover expired leases → claim next pending job → execute → complete or retry/dead
4. On SIGINT/SIGTERM or `worker stop`: stop claiming, finish in-flight job, mark `stopped`

## Lease Recovery

- Claim sets `lease_until = now + lease-timeout-ms`
- Heartbeat refreshes `lease_until` while job runs
- If worker dies (`kill -9`), lease expires
- Recovery sets expired `processing` jobs back to `pending`
- Separately, workers with stale heartbeats are marked `stopped` so `status` does not show zombies

Default timeout 30s keeps worst-case job recovery under 60 seconds.

## Retry / DLQ

- Attempts increment at claim time
- On failure: if `attempts > max_retries` → `dead`, else `pending` with `available_at = now + (backoff-base ^ attempts) seconds`
- Operators requeue via `queuectl dlq retry <id>`
