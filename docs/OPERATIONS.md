# Operations and recovery

These commands can affect real mainnet assets. Use them only within the operator's authorization. Never run refund/withdrawal commands as a health check.

## Routine checks

- API: `GET /api/health`; inspect both database and worker readiness.
- Worker: `GET /` on its health port; HTTP 200 means its heartbeat is recent, otherwise 503.
- Deployment: inspect worker startup and subsequent retry/finalization events. A startup message is not proof that every integration works.
- Transactions: use authenticated `GET /api/transactions/:id`, wallet activity, or scoped read-only database inspection. Prefer finalized chain evidence to a browser notification.

Keep provider IDs, Vercel URL, Railway service/environment, treasury public address and database ownership in private deployment records. Use only `artemi_` objects in the shared database. This repository deliberately does not preconfigure another account's provider projects.

## Local treasury setup

`node scripts/init-treasury.mjs` creates `.secrets/treasury.json` exclusively and prints its public address. It never overwrites an existing key. Back it up privately before funding it. On Unix the file is created with owner-only permissions; on Windows also restrict its ACL to the operator account. Do not commit, paste or print it.

Set the public key in both environment files. `npm run worker:local` loads `.env.worker`, then reads the key file only if `ARTEMI_TREASURY_PRIVATE_KEY` is unset. Production starts `npm run worker` and requires the private-key JSON array in Railway secrets. The worker verifies that the secret key matches the configured public key before starting.

## Operator password

Supply `ARTEMI_ADMIN_PASSWORD` through a secure local process environment, then run:

```sh
node scripts/configure-admin-hash.mjs
```

The script writes a fresh salt and scrypt hash to ignored `.env`, without printing the password or hash. Remove the plaintext password from the calling environment afterward. Provision only `ARTEMI_ADMIN_PASSWORD_HASH` to the API runtime; do not deploy the plaintext variable. Changing the hash invalidates existing operator sessions. Wallet authentication is separate.

## Scoped creator refund

Verify the exact mint and its recorded creator before proceeding. The treasury needs SOL for network fees and, if needed, destination token-account rent.

```sh
node --env-file=.env --import tsx scripts/refund-coin.ts MINT
node --env-file=.env --import tsx scripts/verify-refund.ts MINT
```

The refund queues one mint and derives the recipient from its creator record. It pauses the market, waits for in-flight setup/launch/claim attempts to reconcile or provably expire, then transfers that mint's entire remaining treasury balance. It does not reclaim already collected tokens. Re-running the queue command returns the existing matching batch rather than duplicating it.

Verification requires finalized transaction evidence, exact treasury/recipient token deltas and an empty treasury token account. If it reports that no finalized refund exists, wait for the worker and inspect status; do not reset the attempt or broadcast an independent transfer.

After the batch is completed and verified, choose the authorized outcome:

```sh
# Preserve the coin and refund in visible history; reopen the market.
node --env-file=.env --import tsx scripts/resume-refund.ts MINT

# Alternatively, hide the refunded coin from user-facing queries and reopen.
node --env-file=.env --import tsx scripts/archive-refunded-coin.ts MINT
```

Archiving requires finalized creator-refund evidence and retired bags. It retains database audit records and does not erase Solana history. Run the chosen finalization command while that completed batch is still the current operation; do not resume first if archival is desired.

## Emergency withdrawal of every coin

The password-authenticated `/api/admin/withdraw` endpoint accepts a valid destination wallet and exact confirmation `WITHDRAW ALL`. It pauses the market immediately and creates a persistent withdrawal batch for every registered coin. This is a custodial operator power, not a creator feature.

The worker waits for pending user transactions to reconcile, then transfers each mint separately. Therefore a batch may complete partially before retries finish. Treasury SOL pays fees and recipient account rent; token balances are never sold to cover fees. Empty token accounts retire their bags without inventing a transfer event. All relevant token balance changes are verified before finalization.

Completion leaves the market paused. Inspect `/api/admin/status` and explicitly call `/api/admin/resume` when appropriate. Closing the client or losing an HTTP response does not cancel a queued operation.

## Delayed or stuck transactions

| Symptom | Action |
| --- | --- |
| RPC outage or timeout | Restore connectivity and allow the existing attempt to reconcile; do not assume no broadcast occurred |
| Signature confirmed but not finalized | Wait; blockhash expiry alone must not release this reservation |
| Expired blockhash with no chain signature | Let the worker prove expiry and mark the attempt expired before preparing again |
| Insufficient treasury SOL during refund | Fund the existing treasury public address; the worker retries with backoff |
| Wallet rejection before submission | Retry using the existing attempt while valid, or wait for expiry |
| Wallet changed the message | Inspect unsigned diagnostics; never weaken transfer or signature checks to force acceptance |
| Worker restart | Restore the same key/database/network and let persisted attempts reconcile |
| Database unavailable | Restore database connectivity; do not create a replacement empty database for an existing treasury |

Readonly diagnostics:

```sh
node --env-file=.env --import tsx scripts/inspect-launch.ts
node --env-file=.env --import tsx scripts/inspect-wallet-mismatch.ts PUBLIC_WALLET
```

Diagnostics may include public addresses, unsigned instruction data and transaction signatures. Treat them as private operational records. Do not add secrets or usable signed transaction bytes to logs.

## Treasury key recovery

1. Pause new preparations/submissions through the operator controls or stop API traffic, then reconcile existing attempts before manual intervention.
2. Secure the existing key from the operator's encrypted backup or Railway secret storage. Never generate a replacement expecting it to control old token accounts.
3. Verify the recovered public address matches `ARTEMI_TREASURY_PUBLIC_KEY` and the existing treasury accounts.
4. Restore the key only to the worker, and restore the same database and RPC network configuration.
5. Start the worker and inspect health, pending signatures and balances. Restore API traffic only after reconciliation is healthy.

The API does not need the private key. Key rotation to a different wallet is a treasury migration requiring explicit asset/accounting work; changing an environment variable alone is not rotation.

## Upgrade and rollback

Commit code and the lockfile. Run unit tests, type checks, lint and a production build. Use the pinned SDK and official protocol definitions when changing transaction builders. Read-only simulations must verify size, compute, token program, decimals and allocation.

Apply application-only migrations before dependent code, then deploy worker before API. During incompatible transaction changes, pause new operations and reconcile in-flight attempts first. Check historical denomination compatibility. Prefer forward fixes to destructive schema rollback; never delete transaction evidence to make a deployment appear healthy.

Dependencies may have upstream audit advisories. Review them in the context of actual runtime exposure and compatible updates. Do not automatically accept forced major-version downgrades/upgrades in the Solana stack.
