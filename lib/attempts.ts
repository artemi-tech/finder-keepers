import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { NextRequest } from "next/server";
import { z } from "zod";
import {
  buildClaim,
  buildLaunch,
  buildLaunchV1,
  buildLookup,
  DECIMALS,
  rpc,
  treasury,
} from "./chain";
import { db, transaction } from "./db";
import { fail, json, rate } from "./http";
import { BAG_TOKENS, eligible, parseSol, validCoordinates } from "./domain";
import { assertMarketOpen } from "./control";
import {
  decodeWire,
  encodeWire,
  restoreCoSignatures,
  simulateWire,
  validateWalletWire,
  WalletMessageMismatch,
  wireMessage,
} from "./wire";
export async function workerReady() {
  const r = await db().query(
    "SELECT 1 FROM artemi_worker_health WHERE id=1 AND heartbeat_at>now()-interval '90 seconds' AND status='ready'",
  );
  if (!r.rowCount)
    fail(
      "Transaction processing is temporarily offline. Please try again shortly.",
      503,
    );
}
export const validateSigned = validateWalletWire;
export async function prepareLaunch(req: NextRequest, address: string) {
  await workerReady();
  await rate(`launch:${address}`, 5, 60);
  return transaction(async (c) => {
    await assertMarketOpen(c);
    const data = z
      .object({
        uploadId: z.uuid(),
        sol: z.string(),
        version: z.union([z.literal(0), z.literal(1)]).default(0),
      })
      .parse(await json(req));
    let principal: bigint;
    try {
      principal = parseSol(data.sol);
    } catch (e) {
      fail((e as Error).message);
    }
    const upload = (
      await c.query("SELECT * FROM artemi_uploads WHERE id=$1 AND wallet=$2", [
        data.uploadId,
        address,
      ])
    ).rows[0];
    if (!upload) fail("Upload your coin image and metadata first.");
    const active = (
      await c.query(
        "SELECT id,kind,status,transaction_base64 FROM artemi_attempts WHERE wallet=$1 AND kind='launch' AND status IN ('prepared','queued','submitted') ORDER BY created_at DESC LIMIT 1",
        [address],
      )
    ).rows[0];
    if (active)
      return {
        id: active.id,
        kind: active.kind,
        status: active.status,
        transaction: active.transaction_base64,
      };
    const lookupRow = (
      await c.query("SELECT address FROM artemi_lookups WHERE wallet=$1", [
        address,
      ])
    ).rows[0];
    const lookup = lookupRow
      ? (await rpc().getAddressLookupTable(new PublicKey(lookupRow.address)))
          .value
      : null;
    if (data.version === 0 && (!lookup || !lookup.isActive())) {
      const pending = (
        await c.query(
          "SELECT id,status,transaction_base64 FROM artemi_attempts WHERE wallet=$1 AND kind='setup' AND status IN ('prepared','queued','submitted') ORDER BY created_at DESC LIMIT 1",
          [address],
        )
      ).rows[0];
      if (pending)
        return {
          id: pending.id,
          kind: "setup",
          status: pending.status,
          transaction: pending.transaction_base64,
        };
      const setup = await buildLookup(new PublicKey(address));
      const id = randomUUID();
      const bytes = Buffer.from(setup.tx.serialize()).toString("base64");
      await c.query(
        "INSERT INTO artemi_attempts(id,kind,wallet,mint,status,message,transaction_base64,last_valid_height,payload) VALUES($1,'setup',$2,$3,'prepared',$4,$5,$6,$7)",
        [
          id,
          address,
          setup.address.toBase58(),
          Buffer.from(setup.tx.message.serialize()).toString("base64"),
          bytes,
          setup.latest.lastValidBlockHeight,
          JSON.stringify({ address: setup.address.toBase58() }),
        ],
      );
      return { id, kind: "setup", status: "prepared", transaction: bytes };
    }
    const built =
      data.version === 1
        ? await buildLaunchV1(new PublicKey(address), upload, principal)
        : await buildLaunch(new PublicKey(address), upload, principal, lookup!);
    const encoded =
      "transaction" in built
        ? built.transaction
        : Buffer.from(built.tx.serialize()).toString("base64");
    const message =
      "message" in built
        ? built.message
        : Buffer.from(built.tx.message.serialize()).toString("base64");
    const sim = await simulateWire(encoded);
    if (sim.value.err)
      fail(
        "Launch simulation failed. Check your SOL balance and refresh the quote.",
      );
    const id = randomUUID(),
      bytes = encoded;
    const payload = {
      name: upload.name,
      ticker: upload.ticker,
      image: upload.image,
      uri: upload.uri,
      twitter: upload.twitter,
      website: upload.website,
      reward: built.quote.reward.toString(),
      total: built.quote.amount.toString(),
      decimals: DECIMALS,
      treasury: treasury().toBase58(),
      principal: principal.toString(),
      bagTokens: BAG_TOKENS.toString(),
    };
    await c.query(
      "INSERT INTO artemi_attempts(id,kind,wallet,mint,status,message,transaction_base64,last_valid_height,payload) VALUES($1,'launch',$2,$3,'prepared',$4,$5,$6,$7)",
      [
        id,
        address,
        built.mint,
        message,
        bytes,
        built.latest.lastValidBlockHeight,
        JSON.stringify(payload),
      ],
    );
    return {
      id,
      kind: "launch",
      status: "prepared",
      transaction: bytes,
      mint: built.mint,
    };
  });
}

export function ipPosition(req: NextRequest) {
  const latRaw = req.headers.get("x-vercel-ip-latitude"),
    lngRaw = req.headers.get("x-vercel-ip-longitude");
  if (!process.env.VERCEL || !latRaw || !lngRaw) return null;
  const lat = Number(latRaw),
    lng = Number(lngRaw);
  return validCoordinates(lat, lng)
    ? { lat, lng, source: "ip" as const, timestamp: Date.now() }
    : null;
}
export async function prepareClaim(req: NextRequest, address: string) {
  await workerReady();
  await rate(`claim:${address}`, 12);
  const data = z
    .object({
      bagId: z.uuid(),
      position: z
        .object({
          lat: z.number().min(-90).max(90),
          lng: z.number().min(-180).max(180),
          timestamp: z.number(),
          source: z.literal("browser"),
        })
        .optional(),
    })
    .parse(await json(req));
  const position = data.position || ipPosition(req);
  if (!position)
    fail("Location is unavailable. Enable browser location to claim.");
  if (
    position.source === "browser" &&
    (Date.now() - position.timestamp > 120000 ||
      position.timestamp > Date.now() + 10000)
  )
    fail("Refresh your browser location before claiming.");
  return transaction(async (c) => {
    await assertMarketOpen(c);
    const existing = await c.query(
      "SELECT id,status,transaction_base64 FROM artemi_attempts WHERE bag_id=$1 AND wallet=$2 AND status IN ('prepared','queued','submitted')",
      [data.bagId, address],
    );
    if (existing.rowCount)
      return {
        id: existing.rows[0].id,
        status: existing.rows[0].status,
        transaction: existing.rows[0].transaction_base64,
      };
    const r = await c.query(
      "SELECT b.*,l.lat,l.lng,c.decimals FROM artemi_bags b JOIN artemi_locations l ON l.id=b.location_id JOIN artemi_coins c ON c.mint=b.mint WHERE b.id=$1 AND c.archived_at IS NULL FOR UPDATE OF b",
      [data.bagId],
    );
    if (!r.rowCount) fail("Bag not found.", 404);
    const bag = r.rows[0];
    if (bag.status !== "available")
      fail("Someone else has already reserved or claimed this bag.", 409);
    if (!eligible(position, bag))
      fail("You need to be within 10 km of this bag.", 403);
    const built = await buildClaim(
      new PublicKey(address),
      new PublicKey(bag.mint),
      BigInt(bag.amount),
      bag.decimals,
    );
    const sim = await rpc().simulateTransaction(built.tx, {
      sigVerify: false,
      commitment: "confirmed",
    });
    if (sim.value.err)
      fail(
        "Claim simulation failed. You need SOL for network and token-account costs.",
      );
    const id = randomUUID(),
      bytes = Buffer.from(built.tx.serialize()).toString("base64");
    await c.query(
      "UPDATE artemi_bags SET status='reserved',claimant=$2 WHERE id=$1",
      [bag.id, address],
    );
    await c.query(
      "INSERT INTO artemi_attempts(id,kind,wallet,mint,bag_id,status,message,transaction_base64,last_valid_height,payload) VALUES($1,'claim',$2,$3,$4,'prepared',$5,$6,$7,$8)",
      [
        id,
        address,
        bag.mint,
        bag.id,
        Buffer.from(built.tx.message.serialize()).toString("base64"),
        bytes,
        built.latest.lastValidBlockHeight,
        JSON.stringify({
          amount: bag.amount,
          decimals: bag.decimals,
          locationSource: position.source,
          eligible: true,
        }),
      ],
    );
    return { id, status: "prepared", transaction: bytes };
  });
}
export async function submit(req: NextRequest, address: string) {
  await rate(`submit:${address}`, 30);
  const data = z
    .object({ id: z.uuid(), transaction: z.string().max(6000) })
    .parse(await json(req));
  try {
    return await transaction(async (c) => {
      await assertMarketOpen(c);
      const r = await c.query(
        "SELECT * FROM artemi_attempts WHERE id=$1 AND wallet=$2 FOR UPDATE",
        [data.id, address],
      );
      if (!r.rowCount) fail("Transaction not found.", 404);
      const a = r.rows[0];
      if (a.status !== "prepared") return { id: a.id, status: a.status };
      const validated = validateWalletWire(
        a.message,
        data.transaction,
        address,
        a.kind === "setup" || a.kind === "claim",
      );
      const guarded = wireMessage(validated) !== a.message;
      // Launches have a mint co-signature and must remain byte-identical.
      // Setup/claim guards are validated before the worker sees the new bytes.
      const tx = guarded
        ? validated
        : restoreCoSignatures(
            validated,
            decodeWire(a.transaction_base64),
            address,
          );
      if (
        (await rpc().getBlockHeight("confirmed")) > Number(a.last_valid_height)
      )
        fail("Transaction expired. Wait for it to clear, then retry.");
      if (guarded && (await simulateWire(encodeWire(tx))).value.err)
        fail(
          "Your wallet's safety check no longer matches the current chain state. Refresh the quote and retry.",
        );
      await c.query(
        "UPDATE artemi_attempts SET status='queued',signed_base64=$2,message=$3,updated_at=now() WHERE id=$1",
        [a.id, encodeWire(tx), wireMessage(tx)],
      );
      return { id: a.id, status: "queued" };
    });
  } catch (e) {
    if (e instanceof WalletMessageMismatch) {
      // Save only unsigned message bytes, never a usable signed transaction.
      // This runs after rollback so a rejected submission keeps its diagnostic.
      await db().query(
        "UPDATE artemi_attempts SET payload=jsonb_set(payload,'{walletDiagnostic}',$3::jsonb) WHERE id=$1 AND wallet=$2",
        [
          data.id,
          address,
          JSON.stringify({
            receivedMessage: e.receivedMessage,
            at: new Date().toISOString(),
          }),
        ],
      );
    }
    throw e;
  }
}
