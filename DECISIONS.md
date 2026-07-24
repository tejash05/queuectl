# QueueCTL Engineering Decisions

This document records why QueueCTL is built the way it is.
Entries are added as features land.

## Stack

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript (strict) | Interview-ready type safety without framework bloat |
| Runtime | Node.js >= 20 | Modern ESM, stable `child_process`, native `crypto.randomUUID` |
| Database | SQLite via `better-sqlite3` | Zero ops, durable, supports atomic claims with `BEGIN IMMEDIATE` |
| CLI | Commander.js | Familiar subcommand UX (kubectl / docker style) |
| Package manager | npm | Widest review familiarity |

## Architecture

Layered clean architecture:

1. **CLI** — parse args, format output, exit codes
2. **Services** — business rules (claim, retry, DLQ, recovery)
3. **Repositories** — SQL only
4. **Database** — connection, migrations, schema

Dependency direction is always inward: CLI → core → repositories → database.
