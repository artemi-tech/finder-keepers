# Backend verification map

Run `npm test` from the repository root. The runner executes `*.test.ts` files with Node's test runner through `tsx`. No environment file is loaded by this command. Database unit tests use disposable PGlite instances.

| Test file | Main concern |
| --- | --- |
| `domain.test.ts` | SOL parsing, fixed-principal arithmetic, whole bags/remainders, historic denominations, regional counts, radius math |
| `geography.test.ts` | Sampling coverage, land boundaries and geographic distribution |
| `wire.test.ts` | Wire formats, signing, codecs and co-signature handling |
| `transaction.test.ts` | Wallet signature and message integrity |
| `wallet-guards.test.ts` | Allowed readonly wallet guards versus unsafe message changes |
| `retry.test.ts` | Upload retry deduplication and related persistence behavior |
| `reconciliation.test.ts` | Finality/expiry decisions, including pending signatures beyond blockhash lifetime |
| `emergency.test.ts` | Operator pause/withdrawal controls and validation |
| `refund.test.ts` | Scoped refunds, finalization checks, archives and retained accounting |
| `coin-image.test.ts` | Stored image resolution and invalid/missing image handling |

Read the assertions for exact coverage. Mocks and in-memory databases do not validate live RPC behavior, wallet-extension changes, provider configuration or current protocol fees.

`scripts/test-database.ts` and `scripts/test-catalog.ts` provide separate PostgreSQL integration checks using disposable named schemas. `scripts/probe-single-launch.ts` performs a read-only chain simulation. `scripts/test-api.mjs` tests an already running API. Their side effects and commands are listed in [REPLICATION.md](../docs/REPLICATION.md).

For changes to accounting or transaction behavior, retain fixtures for old denominations and both supported wire formats. Confirm simulation separately from real wallet-authorized, finalized transfers. Never add production secret keys or signed transaction payloads as test fixtures.
