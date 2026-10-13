import { createServer } from "node:http";
import { randomInt, randomUUID } from "node:crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import type { PoolClient } from "pg";
import { db, transaction } from "../lib/db";
import { rpc, treasury } from "../lib/chain";
import { partition, regionalCounts } from "../lib/domain";
import { randomLandLocation } from "../lib/geography";
import { reconciliationAction } from "../lib/reconciliation";
import { emergencyTick, finalizeWithdrawal } from "./emergency";
import {
  decodeWire,
  encodeWire,
  wireMessage,
  signWire,
  verifyWireSignatures,
  wireSignature,
  finalizedWire,
  broadcastWire,
} from "../lib/wire";
type Attempt = {
  id: string;
  kind: "launch" | "claim" | "setup" | "withdrawal";
  wallet: string;
  mint: string;
  bag_id: string | null;
  status: string;
  message: string;
  signed_base64: string | null;
  signature: string | null;
  last_valid_height: string;
  payload: Record<string, string | number>;
  tries: number;
};
const key = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(process.env.ARTEMI_TREASURY_PRIVATE_KEY || "[]")),
);
if (!key.publicKey.equals(treasury()))
  throw new Error("Treasury key does not match configured public address.");
let stopping = false,
  lastHeartbeat = 0;
const health = createServer((_req, res) => {
  const ready = Date.now() - lastHeartbeat < 90000;
  res.writeHead(ready ? 200 : 503, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ service: "artemi-worker", ready }));
}).listen(Number(process.env.PORT || 8080), "0.0.0.0");
async function release(
  c: PoolClient,
  a: Attempt,
  status: string,
  error: string,
) {
  await c.query(
    "UPDATE artemi_attempts SET status=$2,error=$3,updated_at=now() WHERE id=$1",
    [a.id, status, error],
  );
  if (a.kind === "claim")
    await c.query(
      "UPDATE artemi_bags SET status='available',claimant=NULL WHERE id=$1 AND status='reserved'",
      [a.bag_id],
    );
}
async function finalize(c: PoolClient, a: Attempt) {
  const chain = await finalizedWire(a.signature!);
  if (!chain) throw new Error("Finalized transaction not available yet.");
  if (chain.meta?.err) {
    await release(
      c,
      a,
      "failed",
      "The transaction failed on-chain. Funds were not transferred.",
    );
    return;
  }
  if (wireMessage(decodeWire(chain.transaction[0])) !== a.message)
    throw new Error("Transaction message mismatch.");
  const delta = (owner: string) => {
    const total = (
      entries: typeof chain.meta extends never
        ? never
        : NonNullable<typeof chain.meta>["postTokenBalances"],
    ) =>
      (entries || [])
        .filter((b) => b.mint === a.mint && b.owner === owner)
        .reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
    return (
      total(chain.meta?.postTokenBalances) - total(chain.meta?.preTokenBalances)
    );
  };
  if (a.kind === "setup") {
    const lookup = (
      await rpc().getAddressLookupTable(new PublicKey(a.mint), {
        commitment: "finalized",
      })
    ).value;
    if (
      !lookup ||
      !lookup.isActive() ||
      lookup.state.authority?.toBase58() !== a.wallet
    )
      throw new Error("Lookup verification failed.");
    await c.query(
      "INSERT INTO artemi_lookups(wallet,address) VALUES($1,$2) ON CONFLICT(wallet) DO UPDATE SET address=excluded.address",
      [a.wallet, a.mint],
    );
  } else if (a.kind === "launch") {
    if (delta(treasury().toBase58()) !== BigInt(a.payload.reward))
      throw new Error("Treasury deposit mismatch.");
    if (delta(a.wallet) !== BigInt(a.payload.total) - BigInt(a.payload.reward))
      throw new Error("Creator allocation mismatch.");
    const mint = await getMint(
      rpc(),
      new PublicKey(a.mint),
      "finalized",
      TOKEN_2022_PROGRAM_ID,
    );
    if (mint.decimals !== Number(a.payload.decimals))
      throw new Error("Mint decimals mismatch.");
    // Preserve the denomination accepted when this launch was prepared.
    // Attempts from the preceding release used 500k bags before this was explicit.
    const bagTokens = BigInt(a.payload.bagTokens ?? 500_000);
    const inserted = await c.query(
      "INSERT INTO artemi_coins(mint,name,ticker,image,uri,creator,twitter,website,treasury_amount,decimals,launch_signature,bag_tokens) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(mint) DO NOTHING RETURNING mint",
      [
        a.mint,
        a.payload.name,
        a.payload.ticker,
        a.payload.image,
        a.payload.uri,
        a.wallet,
        a.payload.twitter,
        a.payload.website,
        a.payload.reward,
        a.payload.decimals,
        a.signature,
        bagTokens.toString(),
      ],
    );
    if (inserted.rowCount) {
      const parts = partition(BigInt(a.payload.reward), mint.decimals, bagTokens);
      const counts = regionalCounts(parts.count, randomInt(2) === 0);
      for (const region of ["EU", "US"] as const) {
        for (let i = 0; i < counts[region]; i++) {
          const place = randomLandLocation(region),
            locationId = randomUUID();
          await c.query(
            "INSERT INTO artemi_locations(id,name,region,lat,lng,source,version) VALUES($1,$2,$3,$4,$5,$6,$7)",
            [
              locationId,
              place.name,
              region,
              place.lat,
              place.lng,
              place.source,
              place.version,
            ],
          );
          await c.query(
            "INSERT INTO artemi_bags(id,mint,location_id,amount) VALUES($1,$2,$3,$4)",
            [randomUUID(), a.mint, locationId, parts.size.toString()],
          );
        }
      }
    }
  } else {
    if (
      delta(a.wallet) !== BigInt(a.payload.amount) ||
      delta(treasury().toBase58()) !== -BigInt(a.payload.amount)
    )
      throw new Error("Claim transfer mismatch.");
    if (a.kind === "withdrawal") await finalizeWithdrawal(c, a);
    else
      await c.query(
        "UPDATE artemi_bags SET status='claimed',claim_signature=$2 WHERE id=$1 AND claimant=$3 AND status='reserved'",
        [a.bag_id, a.signature, a.wallet],
      );
  }
  await c.query(
    "UPDATE artemi_attempts SET status='finalized',error=NULL,updated_at=now() WHERE id=$1",
    [a.id],
  );
  console.log(
    JSON.stringify({
      event: "finalized",
      kind: a.kind,
      id: a.id,
      signature: a.signature,
    }),
  );
}
async function tick() {
  let broadcast: { bytes: Buffer; id: string } | undefined;
  let found = false;
  await transaction(async (c) => {
    const row = await c.query(
      "SELECT * FROM artemi_attempts WHERE status IN ('prepared','queued','submitted') AND next_retry_at<=now() ORDER BY next_retry_at,created_at LIMIT 1 FOR UPDATE SKIP LOCKED",
    );
    if (!row.rowCount) return;
    found = true;
    const a: Attempt = row.rows[0];
    await c.query("SAVEPOINT process_attempt");
    try {
      if (a.signature) {
        const result = (
          await rpc().getSignatureStatuses([a.signature], {
            searchTransactionHistory: true,
          })
        ).value[0];
        if (
          reconciliationAction(result, 0, Number(a.last_valid_height)) ===
          "finalize"
        ) {
          await finalize(c, a);
          return;
        }
        if (result) {
          await c.query(
            "UPDATE artemi_attempts SET next_retry_at=now()+interval '5 seconds' WHERE id=$1",
            [a.id],
          );
          return;
        }
      }
      if (
        reconciliationAction(
          null,
          await rpc().getBlockHeight("finalized"),
          Number(a.last_valid_height),
        ) === "expire"
      ) {
        await release(
          c,
          a,
          "expired",
          "The transaction expired without finalizing. You can try again.",
        );
        return;
      }
      if (a.status === "queued") {
        let tx = decodeWire(a.signed_base64!);
        if (wireMessage(tx) !== a.message)
          throw new Error("Stored message mismatch.");
        if (a.kind === "claim" || a.kind === "withdrawal")
          tx = signWire(tx, key);
        verifyWireSignatures(tx);
        const bytes = Buffer.from(encodeWire(tx), "base64"),
          signature = wireSignature(tx);
        await c.query(
          "UPDATE artemi_attempts SET status='submitted',signed_base64=$2,signature=$3,updated_at=now(),next_retry_at=now()+interval '5 seconds' WHERE id=$1",
          [a.id, bytes.toString("base64"), signature],
        );
        broadcast = { bytes, id: a.id };
      } else if (a.status === "submitted") {
        broadcast = {
          bytes: Buffer.from(a.signed_base64!, "base64"),
          id: a.id,
        };
        await c.query(
          "UPDATE artemi_attempts SET next_retry_at=now()+interval '8 seconds' WHERE id=$1",
          [a.id],
        );
      } else
        await c.query(
          "UPDATE artemi_attempts SET next_retry_at=now()+interval '8 seconds' WHERE id=$1",
          [a.id],
        );
    } catch (e) {
      await c.query("ROLLBACK TO SAVEPOINT process_attempt");
      broadcast = undefined;
      const delay = Math.min(60, 2 ** Math.min(a.tries + 1, 6));
      await c.query(
        "UPDATE artemi_attempts SET tries=tries+1,next_retry_at=now()+$2*interval '1 second',error=$3 WHERE id=$1",
        [
          a.id,
          delay,
          "Confirmation delayed. Artemi is checking the transaction.",
        ],
      );
      console.error(
        JSON.stringify({
          event: "retry",
          id: a.id,
          type: e instanceof Error ? e.name : "unknown",
        }),
      );
    }
  });
  // Database commit precedes broadcast. A crash here safely resends the same signature.
  if (broadcast)
    try {
      await broadcastWire(broadcast.bytes.toString("base64"));
    } catch {
      console.warn(
        JSON.stringify({ event: "broadcast_retry", id: broadcast.id }),
      );
    }
  return found;
}
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
  });
console.log(
  JSON.stringify({
    event: "worker_started",
    treasury: key.publicKey.toBase58(),
  }),
);
while (!stopping) {
  try {
    for (let i = 0; i < 10 && !stopping; i++) {
      if (!(await tick())) break;
    }
    await emergencyTick();
    await db().query(
      "INSERT INTO artemi_worker_health(id,heartbeat_at,status) VALUES(1,now(),'ready') ON CONFLICT(id) DO UPDATE SET heartbeat_at=now(),status='ready'",
    );
    lastHeartbeat = Date.now();
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "worker_error",
        type: e instanceof Error ? e.name : "unknown",
      }),
    );
  }
  await new Promise((r) => setTimeout(r, 2000));
}
await db().query(
  "UPDATE artemi_worker_health SET status='stopped',heartbeat_at=now() WHERE id=1",
);
health.close();
await db().end();
