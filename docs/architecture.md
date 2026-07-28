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

Exact timeline:

1. Worker claims job (`state=processing`, lease written).
2. Worker crashes (`SIGKILL`) — no cleanup.
3. Lease expires (`lease_until < now`).
4. `RecoveryService` resets job to `pending` and logs `Stale Job Recovered`.
5. Another worker claims it atomically.
6. Job completes.

Default `lease-timeout-ms=30000` ⇒ worst-case recovery **~30 seconds** (under the 60s assignment cap).

Separately, workers with stale heartbeats are marked `stopped` so `status` does not show zombies.

## Retry / DLQ

- Attempts increment at claim time
- On failure: if `attempts > max_retries` → `dead`, else `pending` with `available_at = now + (backoff-base ^ attempts) seconds`
- Operators requeue via `queuectl dlq retry <id>`
