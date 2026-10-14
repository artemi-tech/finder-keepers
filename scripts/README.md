# Script inventory

Run scripts from the repository root. npm commands specify environment loading where needed; direct TypeScript commands use `node --env-file=.env --import tsx scripts/NAME.ts`. Do not assume a plain Node command loads `.env`.

| Script | Purpose / effects |
| --- | --- |
| `example-allocation.ts` | Offline fixture using actual accounting functions; prints integer allocation only |
| `migrate.ts` | Applies unapplied application SQL and records filenames; database writes |
| `init-treasury.mjs` | Creates a new local private key exclusively; prints only its public address |
| `worker-local.ts` | Loads local treasury key when no private-key environment value is set, then starts worker |
| `configure-admin-hash.mjs` | Reads process `ARTEMI_ADMIN_PASSWORD`, writes salted hash into ignored `.env` |
| `probe-single-launch.ts` | RPC reads/simulation for launch compatibility; no broadcast |
| `test-api.mjs` | Exercises running API; authentication/rate records and quote reads |
| `test-database.ts`, `test-catalog.ts` | Isolated PostgreSQL schema integration checks |
| `build-geography.mjs` | Downloads pinned boundary source and regenerates committed land data |
| `inspect-launch.ts`, `inspect-wallet-mismatch.ts` | Read-only transaction diagnostics; output belongs in private operations records |
| `refund-coin.ts` | Queues a real treasury refund for one coin's recorded creator; pauses market |
| `verify-refund.ts` | Checks finalized refund evidence and token deltas |
| `resume-refund.ts` | Reopens after the verified completed refund |
| `archive-refunded-coin.ts` | Archives a refunded coin and reopens; retains audit history |

Refund commands are asset-moving operations, not smoke tests. Follow [OPERATIONS.md](../docs/OPERATIONS.md) for exact arguments and the required sequence. Do not run both resume and archive as successive steps: choose the authorized outcome while the completed batch is current.
