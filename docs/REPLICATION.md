# Reproduce and run the backend

[Back to README](../README.md) · [API contract](API.md) · [Operations](OPERATIONS.md)

This guide separates checks that need no credentials from operations that connect to providers or move assets. The repository includes the API, worker, migrations, geographic data and tests. It does not include production secrets, transaction history or permission to operate Artemi's existing treasury. Public source visibility is not an open-source license; see the README's license note.

## 1. Install the exact dependency set

Use Node.js **24.x** and npm. Record the checked-out revision when reproducing a result:

```sh
git clone https://github.com/artemi-tech/finder-keepers.git
cd finder-keepers
git rev-parse HEAD
node --version
npm ci
```

Keep `package-lock.json`; do not substitute `npm install` with unreviewed upgrades. The source targets pump.fun Token-2022 launches and the pinned SDK/RPC transaction formats. Pointing at devnet alone does not reproduce the mainnet protocol deployment.

## 2. Run the offline checks first

```sh
npm run example:allocation
npm test
npm run typecheck
npm run lint
npm run build
```

These commands do not require provider credentials or broadcast transactions. The example imports the real accounting functions and uses fixed reserve fixtures; it is not a current market quote. Expected treasury amount: `7105960264900` base units, with 23 bags of `300000000000` units and a remainder of `205960264900` units. A 2 SOL fixture purchase gives the creator the purchased tokens above the same fixed reward allocation.

The tests use in-memory PGlite where database behavior is required. Inspect [tests/README.md](../tests/README.md) for coverage and limits. Successful tests/builds do not prove a live launch or claim.

## 3. Configure separate API and worker environments

Copy the templates using your shell:

```sh
# POSIX shell
cp .env.example .env
cp .env.worker.example .env.worker
```

```powershell
# PowerShell
Copy-Item .env.example .env
Copy-Item .env.worker.example .env.worker
```

Fill in the [configuration matrix](../README.md#configuration). The API needs the database, RPC, treasury public key and Pinata upload/gateway values. The worker needs the same database/network/public key and its private signing key. The operator password hash is optional until operator endpoints are needed. Use placeholders only in committed templates.

For an independent installation, provide a database you administer and create a **new** treasury:

```sh
node scripts/init-treasury.mjs
```

Record the printed public address in both environment files. Back up `.secrets/treasury.json` securely and restrict file access; it is ignored by Git. For local work, leave the private-key variable empty and let `worker:local` read this file. Never copy a key into terminal output, issue reports or API configuration. For an existing deployment, restore its existing key instead of running key generation. See [TREASURY.md](TREASURY.md).

## 4. Migrate and start

```sh
npm run db:migrate
npm run dev
```

In a separate terminal:

```sh
npm run worker:local
```

Only one migration runner should execute at a time. It owns `artemi_` objects and records applied filenames; it must not reset unrelated data. Next.js loads `.env`; the migration command explicitly loads `.env`; `worker:local` explicitly loads `.env.worker`. The production `worker` command requires environment variables to be injected by its host.

Verify `GET http://localhost:3000/api/health` reports `database: true` and `worker: true`. Verify the worker health server at `http://localhost:8080/` returns HTTP 200 and `ready: true`. A worker key/public-address mismatch is a startup failure. Readiness requires a recent successful loop, not merely a running process.

## 5. Exercise the API without broadcasting

The [API reference](API.md) specifies request bodies, cookies, origins and encodings. From the project directory:

```sh
npm run test:api -- http://localhost:3000
node --env-file=.env --import tsx scripts/probe-single-launch.ts 0.2
```

The API check writes temporary authentication/throttling records and fetches live quotes. The probe queries mainnet and simulates transactions; neither command broadcasts a launch. RPC/network/SDK support can cause simulation to fail even when offline tests pass. Do not treat simulation as settlement.

Optional real-PostgreSQL checks create and remove their own `artemi_test_<uuid>` schemas:

```sh
node --env-file=.env --import tsx scripts/test-database.ts
node --env-file=.env --import tsx scripts/test-catalog.ts
```

Run these only against a database you administer. They need permission to create schemas; they must not be replaced with a database-wide reset.

## 6. Complete an authorized launch and claim

Use a funded wallet you control and an authenticated client that follows the API contract. The server never receives the wallet's private key.

1. Request a challenge, sign its exact message and verify it to establish the session cookie. Preserve the required matching `Origin` header on mutations.
2. Upload metadata, request a fresh quote, then prepare a launch with at least `"0.2"` SOL principal. Budget separately for protocol fees, network fees and account rent.
3. Sign the returned transaction in a supported format. If the attempt kind is `setup`, submit and wait for finalized status before preparing the launch again.
4. Submit the signed launch and retain its attempt ID. Poll until `finalized`. Check its signature on the configured network and verify the registered mint, allocation and bag count.
5. From an eligible location, prepare a bag claim with a current position, or omit it to use trusted Vercel IP evidence. Locally, IP fallback is normally unavailable. Do not spoof production location headers to make a test pass.
6. Sign as claimant, submit and poll the same attempt. Check finalized recipient/treasury token deltas and claimed status. The claimant must have SOL for fees and any new token account.

Rejected signing is not a submission. A lost HTTP response after submission is not proof of failure. Recover through `/api/wallet/activity` and `/api/transactions/:id`; let the worker reconcile before trying a replacement attempt. Preserve transaction evidence in private operational records.

## 7. Deploy independent services

Use the [README deployment settings](../README.md#deployment) for Vercel and Railway. Configure only each service's required variables; management tokens are not runtime inputs. Production workers take the JSON secret-key array from Railway secrets, not a committed file. Use a Vercel-generated URL.

Apply migrations, deploy the worker, verify readiness, deploy the API, then repeat authorized integration checks against the deployment. Record revision, deployment/service IDs, network, treasury public address, migration filenames and finalized test signatures in private operations records. A production deployment should not reuse Artemi's public treasury address as a sample value.

## 8. Rebuild geographic data only when changing it

`lib/data/land.json` is committed, so ordinary installation does not download map data. To intentionally regenerate it, inspect and run `node scripts/build-geography.mjs`, review the output diff and checksum, and run the geography tests. The generator downloads the pinned Natural Earth source; it is a networked build step. [Boundary documentation](../lib/data/README.md) explains coverage and generalized coastline limits.
