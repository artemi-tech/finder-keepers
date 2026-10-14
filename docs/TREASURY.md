# Treasury, accounts and signing

[Back to README](../README.md) · [Code guide](CODE_GUIDE.md) · [Operations](OPERATIONS.md)

## Public identity

Artemi's existing mainnet treasury authority is:

[`E9h2tNHoZUDmhFqzhDk3GBgWJXz3bdrtDE8soj2BnVNJ`](https://explorer.solana.com/address/E9h2tNHoZUDmhFqzhDk3GBgWJXz3bdrtDE8soj2BnVNJ)

The public address can be used to inspect on-chain activity. It cannot sign transactions. The worker holds the corresponding private key; the API only receives `ARTEMI_TREASURY_PUBLIC_KEY`. This repository contains neither that key nor access to the production database. Balances change, so no static balance in these documents should be treated as a live reserve report.

An independent operator generates a new treasury with `scripts/init-treasury.mjs`. Do not configure the published Artemi address for your own deployment unless you actually operate its key and existing accounting database. Direct deposits do not trigger bag creation or top-up accounting.

## Wallet, token account, mint, program

| Address type | Meaning in Artemi |
| --- | --- |
| Treasury wallet | Signing authority; holds SOL used for operator transfers |
| Treasury associated token account (ATA) | Holds one mint's reward tokens; derived from the treasury wallet, mint and token program |
| Mint | Identifies the coin and its decimals; is not the treasury wallet |
| Program | Executable on-chain code that validates instructions |

The main programs referenced by the builders are:

| Program | Mainnet address | Role |
| --- | --- | --- |
| pump.fun | [`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`](https://explorer.solana.com/address/6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P) | Coin creation and bonding-curve purchase |
| Token-2022 | [`TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`](https://explorer.solana.com/address/TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb) | Mint/token account rules and checked token transfers |
| Associated Token Account | [`ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`](https://explorer.solana.com/address/ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL) | Deterministic token account creation |

These are external programs, not Artemi-owned deployments. The builders also use Solana's System, Compute Budget and Address Lookup Table programs where needed, plus accounts required by the pinned pump SDK. See [chain.ts](../lib/chain.ts), especially `lookupAddresses`, `launchInstructions` and `buildClaim`.

## Who pays a claim fee?

Solana charges the **transaction's fee payer**, independently of whose tokens move. `buildClaim()` sets `payerKey: user`. The same `user` is the payer in `createAssociatedTokenAccountIdempotentInstruction()`, while `treasury()` is the authority in `createTransferCheckedInstruction()`.

```mermaid
sequenceDiagram
    participant C as Claimant wallet
    participant A as API
    participant W as Treasury worker
    participant S as Solana programs
    C->>A: Authenticate and request an eligible bag
    A-->>C: Fixed transaction, claimant is fee payer
    C->>A: Transaction signed by claimant
    A->>A: Validate signature and message; queue
    W->>W: Add treasury signature; persist bytes and identity
    W->>S: Broadcast the same signed transaction
    S->>S: Charge claimant SOL; create ATA if needed; transfer tokens
    W->>S: Read finalized result and token balance changes
    W->>W: Mark the bag claimed
```

Both signatures authorize the same message. The claimant authorizes paying fees; the treasury authorizes spending its tokens. The worker submitting bytes to RPC does **not** make it the fee payer. Claimants need SOL even when the reward itself is a token. They do not send a separate fee payment to Artemi.

| Operation | Fee payer | Other costs |
| --- | --- | --- |
| Lookup setup / launch | Creator | Setup/mint/account rent, purchase principal and protocol costs |
| Bag claim | Claimant | Recipient ATA rent when a new account is required |
| Emergency withdrawal / creator refund | Treasury | Destination ATA rent when needed |

Claim instructions currently request 80,000 compute units at 10,000 micro-lamports per unit. That encodes an 800-lamport priority fee; it is **not the total transaction cost**. Base signature fees and any account rent are additional. The chain and actual account state determine the final debit. A transaction that executes and fails can still charge a network fee; failure does not mean every SOL cost is refunded.

## Reward accounting

`quoteLaunch()` calculates both the full creator purchase and the fixed 0.2 SOL reward purchase from the same initial reserve values using integer arithmetic. The creator keeps `total - reward` tokens. Protocol costs are quoted separately. `partition()` divides the reward into whole bags plus a retained remainder.

Each launch's `payload.bagTokens` freezes its denomination. Registration writes `artemi_coins.bag_tokens` and each bag's base-unit `amount`. Claims use the persisted bag amount, not a newly evaluated global default. Existing 100k/500k bags therefore survive later changes to the 300k default.

The database's `treasury_amount` is the **original reward allocation**, not a continuously refreshed chain balance. `reservedRewards()` subtracts finalized claims and withdrawals for accounting. Unsolicited transfers, manual transactions or a compromised key can make chain balances differ. Reconcile with the relevant Token-2022 accounts before any operational intervention.

## Custody and recovery

The operator controls this wallet and can withdraw unclaimed rewards. Location checks and bag reservations are enforced by the backend, not by an on-chain escrow. No published custom program prevents an operator from signing a different transfer outside the service.

Recovery requires the same private key, database and network. Replacing only the public-address environment variable does not transfer existing tokens or repair accounting. Follow [treasury recovery](OPERATIONS.md#treasury-key-recovery) and [emergency withdrawal procedures](OPERATIONS.md#emergency-withdrawal-of-every-coin).
