import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import { NextRequest } from "next/server";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import { metadata } from "../lib/pinata";
import { submit } from "../lib/attempts";
import { rate, handle } from "../lib/http";
import { rpc } from "../lib/chain";
import { LIGHTHOUSE } from "../lib/wallet-guards";
import { decodeWire, wireMessage, verifyWireSignatures } from "../lib/wire";

test("retries reuse storage, rate limits report reset time, and rejected messages retain signature-free diagnostics", async () => {
  const pg = new PGlite();
  const adapter = {
    query: async (sql: string, params?: unknown[]) => {
      const r = await pg.query(sql, params);
      return { ...r, rowCount: r.rows.length || r.affectedRows || 0 };
    },
    connect: async () => ({ ...adapter, release() {} }),
  };
  (globalThis as unknown as { artemiPool: Pool }).artemiPool =
    adapter as unknown as Pool;
  const originalFetch = globalThis.fetch;
  let uploads = 0;
  globalThis.fetch = async () => {
    uploads++;
    return Response.json({ data: { cid: `bafyTest${uploads}` } });
  };
  try {
    for (const f of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await pg.exec(await readFile(`migrations/${f}`, "utf8"));
    const owner = Keypair.generate(),
      wallet = owner.publicKey.toBase58();
    await pg.query("UPDATE artemi_controls SET paused=false WHERE id=1");
    function request(name = "Retry coin") {
      const body = new FormData();
      body.set("name", name);
      body.set("ticker", "TEST");
      body.set(
        "image",
        new File([new Uint8Array([137, 80, 78, 71, 0])], "image.png", {
          type: "image/png",
        }),
      );
      return new NextRequest("https://artemi.test/api/metadata", {
        method: "POST",
        body,
      });
    }
    const first = await metadata(request(), wallet);
    // Exhaust the new-upload budget, then retry identical bytes after a lost response.
    await pg.query("UPDATE artemi_rates SET hits=5 WHERE key=$1", [
      `upload:${wallet}`,
    ]);
    for (let n = 0; n < 6; n++)
      assert.deepEqual(await metadata(request(), wallet), first);
    assert.equal(uploads, 2);
    assert.equal(
      (
        await pg.query<{ hits: number }>(
          "SELECT hits FROM artemi_rates WHERE key=$1",
          [`upload:${wallet}`],
        )
      ).rows[0].hits,
      5,
    );
    const limited = await handle(() =>
      metadata(request("Different coin"), wallet),
    );
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("Retry-After")) > 0);
    assert.ok((await limited.json()).retryAfter > 0);
    await rate("short-test", 1, 12);
    const short = await handle(() => rate("short-test", 1, 12));
    assert.equal(short.headers.get("Retry-After"), "12");
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner.publicKey,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [
          SystemProgram.transfer({
            fromPubkey: owner.publicKey,
            toPubkey: Keypair.generate().publicKey,
            lamports: 100,
          }),
        ],
      }).compileToV0Message(),
    );
    const id = randomUUID(),
      expected = Buffer.from(tx.message.serialize()).toString("base64");
    await pg.query(
      "INSERT INTO artemi_attempts(id,kind,wallet,mint,status,message,transaction_base64,last_valid_height,payload) VALUES($1,'setup',$2,$2,'prepared',$3,$4,100,'{}')",
      [id, wallet, expected, Buffer.from(tx.serialize()).toString("base64")],
    );
    tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
    tx.sign([owner]);
    await assert.rejects(
      submit(
        new NextRequest("https://artemi.test/api/transactions/submit", {
          method: "POST",
          body: JSON.stringify({
            id,
            transaction: Buffer.from(tx.serialize()).toString("base64"),
          }),
        }),
        wallet,
      ),
      /changed/,
    );
    const row = (
      await pg.query<{
        status: string;
        signed_base64: null;
        signature: null;
        payload: { walletDiagnostic: { receivedMessage: string } };
      }>("SELECT * FROM artemi_attempts WHERE id=$1", [id])
    ).rows[0];
    assert.equal(row.status, "prepared");
    assert.equal(row.signed_base64, null);
    assert.equal(row.signature, null);
    assert.equal(
      row.payload.walletDiagnostic.receivedMessage,
      Buffer.from(tx.message.serialize()).toString("base64"),
    );
    const original = TransactionMessage.decompile(
      VersionedTransaction.deserialize(
        Buffer.from(
          (
            await pg.query<{ transaction_base64: string }>(
              "SELECT transaction_base64 FROM artemi_attempts WHERE id=$1",
              [id],
            )
          ).rows[0].transaction_base64,
          "base64",
        ),
      ).message,
    );
    const guarded = new VersionedTransaction(
      new TransactionMessage({
        ...original,
        instructions: [
          ...original.instructions,
          new TransactionInstruction({
            programId: new PublicKey(LIGHTHOUSE),
            keys: [
              { pubkey: owner.publicKey, isSigner: true, isWritable: true },
            ],
            data: Buffer.from("06040100000000000000000000", "hex"),
          }),
        ],
      }).compileToV0Message(),
    );
    guarded.sign([owner]);
    process.env.SOLANA_HTTPS_ENDPOINT = "http://127.0.0.1:1";
    const connection = rpc(),
      oldHeight = connection.getBlockHeight;
    connection.getBlockHeight = async () => 10;
    globalThis.fetch = async (_url, options) =>
      Response.json({
        jsonrpc: "2.0",
        id: JSON.parse(String(options?.body)).id,
        result: { context: { slot: 1 }, value: { err: null, logs: [] } },
      });
    try {
      const result = await submit(
        new NextRequest("https://artemi.test/api/transactions/submit", {
          method: "POST",
          body: JSON.stringify({
            id,
            transaction: Buffer.from(guarded.serialize()).toString("base64"),
          }),
        }),
        wallet,
      );
      assert.equal(result.status, "queued");
      const queued = (
        await pg.query<{
          message: string;
          signed_base64: string;
          transaction_base64: string;
        }>("SELECT * FROM artemi_attempts WHERE id=$1", [id])
      ).rows[0];
      assert.equal(
        queued.message,
        Buffer.from(guarded.message.serialize()).toString("base64"),
      );
      assert.equal(
        wireMessage(decodeWire(queued.signed_base64)),
        queued.message,
      );
      verifyWireSignatures(decodeWire(queued.signed_base64));
      assert.notEqual(queued.signed_base64, queued.transaction_base64);
    } finally {
      connection.getBlockHeight = oldHeight;
    }
  } finally {
    globalThis.fetch = originalFetch;
    await pg.close();
  }
});
