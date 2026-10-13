# API reference

Base path: `/api`. JSON mutations require `Content-Type: application/json` and an `Origin` matching the request origin. Authentication is cookie-based; browser callers must preserve cookies. The metadata endpoint uses multipart form data.

Lamports, token base units, and SOL input values are **decimal strings**. Token mint addresses and wallet addresses are base58 strings. Transaction/message bytes and signatures exchanged with the wallet are base64 unless a response explicitly contains the base58 on-chain transaction signature.

## Public endpoints

| Method | Path | Result / query |
| --- | --- | --- |
| GET | `/health` | `{ database: true, worker: boolean }`; inspect both values |
| GET | `/location` | `{ position: { lat, lng, source: "ip", timestamp } \| null }` from trusted Vercel headers |
| GET | `/map?mint=…` | `{ bags, coins, paused }`; optional bag mint filter; retired bags and archived coins excluded |
| GET | `/coins?q=…&sort=oldest&page=1` | Search name/ticker/mint; newest by default; 24-item pages and aggregate counts |
| GET | `/activity?kind=claim&page=1` | Finalized launch/claim/withdrawal events; `kind=all` by default; `preview=1` returns five items |
| GET | `/value/:mint` | `{ lamports: string \| null, updatedAt, basis }`; estimated sell value for that coin's bag denomination |
| GET | `/coin-image/:mint` | Bounded image bytes from the stored CID through Pinata; not an arbitrary-URL proxy |
| GET | `/auth/session` | `{ wallet: string \| null }` |

`/coins` returns `{ coins, total, totalCoins, totalBags, claimedBags, page, pageSize }`. `/activity` returns `{ events, total, page, pageSize }`. Coin rows include mint/name/ticker/image, creator/social links, decimals, treasury allocation, bag denomination, launch signature, withdrawal accounting, and bag counts. Map bags include ID, mint, name/ticker/image, position/place/region, state and base-unit amount. Coin details can be built from these rows; there is no separate `GET /coins/:mint` endpoint.

Market values are cached for 30 seconds and can be unavailable for graduated or missing bonding curves. Null is not zero. Quotes exclude network costs and price movement. Image caching differs from JSON: successful image responses have browser/edge caching, while failures are not cached.

## Wallet authentication

1. `POST /auth/challenge` with `{ "wallet": "PUBLIC_WALLET_ADDRESS" }` returns `{ id, message }`.
2. Have the wallet sign the exact UTF-8 `message` using Ed25519 message signing.
3. `POST /auth/verify` with `{ "id": "NONCE_UUID", "signature": "BASE64_SIGNATURE" }` returns `{ wallet }` and sets `artemi_session`.
4. Use that cookie for authenticated endpoints. `POST /auth/logout` with `{}` invalidates the session.

Challenges expire after five minutes. Wallet sessions last 24 hours. A message signature authenticates the wallet; it does not authorize a blockchain transfer.

Example challenge from a shell, with a public address you control:

```sh
curl -X POST http://localhost:3000/api/auth/challenge \
  -H 'Origin: http://localhost:3000' \
  -H 'Content-Type: application/json' \
  --data '{"wallet":"YOUR_PUBLIC_WALLET_ADDRESS"}'
```

The signature still has to be produced by the user's wallet. Never send a private key to this API.

## Metadata upload

`POST /metadata` requires a wallet session and these multipart fields:

| Field | Validation |
| --- | --- |
| `name` | Nonempty; maximum 32 UTF-8 bytes |
| `ticker` | 1–10 ASCII letters/digits; normalized uppercase |
| `image` | PNG/JPEG/WebP, at most 3,000,000 bytes, format signature checked |
| `twitter` | Optional HTTPS URL on x.com or twitter.com, including www variants |
| `website` | Optional HTTPS URL |

Response: `{ id, image, uri }`, where `id` becomes `uploadId` for preparation. Metadata belongs to the authenticated wallet. Identical retry uploads reuse a content-derived ID protected by a database advisory lock. New metadata consumes a five-per-hour quota; request throttling is separate.

## Launch quote and preparation

`POST /launch/quote`:

```json
{ "sol": "0.2", "version": 0 }
```

`version` is 0 or 1, default 0. A quote contains:

```text
principal, treasuryTokens, creatorTokens, bags, remainder,
protocolFees, purchaseCost, setupRequired, setupRent,
transactionVersion, approvals, networkEstimate,
accountRentEstimate, totalEstimate
```

All monetary fields are decimal strings. `bags`, `approvals`, and `transactionVersion` are numbers. The principal minimum is 0.2 SOL; protocol fees and estimated account/network costs are separate. Rent/network fields are estimates, not a guarantee of final execution cost.

`POST /launch/prepare`:

```json
{ "uploadId": "UPLOAD_UUID", "sol": "0.2", "version": 0 }
```

Returns `{ id, kind, status, transaction, mint? }`, with a base64 serialized transaction. For v0, `kind: "setup"` means sign/submit the lookup setup, wait for finalization, then call prepare again. `kind: "launch"` is the atomic creation/purchase/funding transaction. The worker must be healthy and the market open. Repeated preparations reuse an active attempt where applicable.

Choose a version supported by the wallet. There is no wallet connection component or version negotiation UI in this repository.

## Claim preparation

`POST /claim/prepare` requires a wallet session:

```json
{
  "bagId": "BAG_UUID",
  "position": {
    "lat": 48.8566,
    "lng": 2.3522,
    "source": "browser",
    "timestamp": 1790000000000
  }
}
```

The coordinates above are illustrative; use the user's fresh browser position and current Unix timestamp in **milliseconds**. Omit `position` to use trusted Vercel IP coordinates when available. Client-supplied `source: "ip"` is not accepted. Stale, invalid, missing or out-of-range evidence prevents the claim.

The endpoint locks/reserves an available bag, simulates the transfer and returns `{ id, status: "prepared", transaction }`. It does not itself submit the transfer. The authenticated wallet is the fee payer and recipient. Moving the map cannot change eligibility.

## Transaction submission and recovery

`POST /transactions/submit`:

```json
{ "id": "ATTEMPT_UUID", "transaction": "BASE64_WALLET_SIGNED_TRANSACTION" }
```

Returns `{ id, status }`. The wallet must sign the prepared transaction, not a rebuilt approximation. Message changes are rejected except for narrowly checked readonly Phantom guards on setup/claim transactions. Launch messages remain strict because of the mint co-signature.

Poll `GET /transactions/:id` with the same wallet session. Response fields: `id`, `kind`, `mint`, `status`, `signature`, `error`. Status is one of `prepared`, `queued`, `submitted`, `finalized`, `failed`, `expired`. Success is **finalized**, not just submitted or confirmed.

`GET /wallet/activity` returns `{ attempts, coins }`, including pending transactions for reconnect recovery. Archived records are filtered out. If a response is lost, recover the existing attempt before preparing another transaction. Never interpret an HTTP timeout as proof that funds did not move.

## Operator API

Operator endpoints use a separate `artemi_admin` cookie and `ARTEMI_ADMIN_PASSWORD_HASH`. They do not use wallet sessions.

| Method | Path | Body / behavior |
| --- | --- | --- |
| POST | `/admin/login` | `{ password }`; establishes a four-hour operator session |
| POST | `/admin/logout` | `{}`; invalidates the operator session |
| GET | `/admin/status` | Paused state, coin/bag counts, withdrawal batches/items, treasury public address and SOL balance |
| POST | `/admin/withdraw` | `{ destination, confirmation: "WITHDRAW ALL" }`; withdraws **every registered coin treasury**, including remainders |
| POST | `/admin/resume` | `{}`; reopens the market only after active withdrawals finish |

There is no operator UI in this repository. Use an authorized operator client. For a refund restricted to one coin's creator, use the scoped CLI described in [OPERATIONS.md](OPERATIONS.md), not the all-coin endpoint.

## Errors and throttling

Errors use `{ "error": "human-readable message" }`. Rate limits additionally return `retryAfter` seconds and a `Retry-After` header.

| HTTP status | Typical meaning |
| --- | --- |
| 400 | Invalid input, expired signing request or rejected transaction |
| 401 | Missing/expired authentication or invalid signature/password |
| 403 | Origin mismatch or claim outside the allowed radius |
| 404 | Unknown/archived resource |
| 409 | Bag conflict or incompatible operation state |
| 413 | Request/image too large |
| 429 | Rate limit; respect the reset interval |
| 503 | Worker unavailable, paused market, or provider/runtime failure |

Current limits include 10 wallet challenges/minute, 20 quotes/minute, 5 launch preparations/minute, 12 claim preparations/minute, 30 submissions/minute, and 30 upload requests/minute. New uploads are capped at five/hour. Operator login is limited per IP and globally. These are application limits, not protections against all forms of Sybil abuse.
