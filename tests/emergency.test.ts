import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { Pool } from "pg";
import {
  Keypair,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import {
  decodeTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { NextRequest } from "next/server";
import { validAdminPassword } from "../lib/admin-password";
import {
  adminLogin,
  adminLogout,
  adminSession,
  queueWithdrawal,
  withdrawalDestination,
  resumeMarket,
} from "../lib/admin";
import { assertMarketOpen } from "../lib/control";
import {
  emergencyInstructions,
  initializeWithdrawal,
  finalizeWithdrawal,
  retireEmptyTreasury,
} from "../worker/emergency";
import { reservedRewards, type Coin } from '../lib/domain';
import { projectActivity } from "../lib/activity";
import { reconciliationAction } from "../lib/reconciliation";

test("emergency control, authentication, accounting, and public activity run in isolated embedded PostgreSQL", async () => {
  const pg = new PGlite();
  const adapter = {
    query: async (sql: string, params?: unknown[]) => {
      const r = await pg.query(sql, params);
      return { ...r, rowCount: r.rowCount ?? r.affectedRows ?? r.rows.length };
    },
    connect: async () => ({ ...adapter, release: () => {} }),
  };
  const pool = adapter as unknown as Pool;
  (globalThis as unknown as { artemiPool: Pool }).artemiPool = pool;
  const owner = Keypair.generate(),
    destination = Keypair.generate().publicKey,
    mint = Keypair.generate().publicKey;
  process.env.ARTEMI_TREASURY_PUBLIC_KEY = owner.publicKey.toBase58();
  const salt = randomBytes(16).toString("hex"),
    password = "local-test-password";
  process.env.ARTEMI_ADMIN_PASSWORD_HASH = `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
  Object.assign(process.env, { NODE_ENV: "production" });
  try {
    for (const file of [
      "001_initial.sql",
      "002_lookup.sql",
      "003_launch_idempotency.sql",
      "004_emergency.sql",
      "005_bag_size_archive.sql",
      "006_300k_bags.sql",
    ])
      await pg.exec(await readFile(`migrations/${file}`, "utf8"));
    const request = (path: string, body?: unknown, cookie?: string) =>
      new NextRequest(`https://artemi.test/api/admin/${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          origin: "https://artemi.test",
          ...(cookie ? { cookie } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    await assert.rejects(
      adminSession(request("status")),
      (e) => (e as { status: number }).status === 401,
    );
    assert.equal(
      validAdminPassword("wrong", process.env.ARTEMI_ADMIN_PASSWORD_HASH),
      false,
    );
    await assert.rejects(
      adminLogin(request("login", { password: "wrong" })),
      (e) => (e as { status: number }).status === 401,
    );
    const response = await adminLogin(request("login", { password }));
    const token = response.cookies.get("artemi_admin")!.value;
    assert.match(response.headers.get("set-cookie")!, /HttpOnly/i);
    assert.match(response.headers.get("set-cookie")!, /Secure/i);
    assert.match(response.headers.get("set-cookie")!, /SameSite=strict/i);
    const cookie = `artemi_admin=${token}`;
    await adminSession(request("status", undefined, cookie));
    assert.equal(
      (
        await pool.query("SELECT token_hash FROM artemi_admin_sessions")
      ).rows[0].token_hash.includes(token),
      false,
    );
    await assert.rejects(async () =>
      withdrawalDestination(owner.publicKey.toBase58()),
    );
    await assert.rejects(async () => withdrawalDestination("invalid"));
    assert.equal(
      withdrawalDestination(destination.toBase58()),
      destination.toBase58(),
    );
    await pool.query(
      "INSERT INTO artemi_coins(mint,name,ticker,image,uri,creator,treasury_amount,decimals,launch_signature) VALUES($1,'Fixture','FIX','','',$2,300000000000,6,'launch-proof')",
      [mint.toBase58(), owner.publicKey.toBase58()],
    );
    await pool.query(
      "INSERT INTO artemi_locations(id,name,region,lat,lng,source) VALUES('fixture','Fixture place','EU',0,0,'test')",
    );
    const claimed = randomUUID(),
      available = randomUUID(),
      reserved = randomUUID();
    for (const [id, status] of [
      [claimed, "claimed"],
      [available, "available"],
      [reserved, "reserved"],
    ])
      await pool.query(
        "INSERT INTO artemi_bags(id,mint,location_id,amount,status) VALUES($1,$2,'fixture',100000000000,$3)",
        [id, mint.toBase58(), status],
      );
    await pool.query("BEGIN");
    await assertMarketOpen(pool);
    const batch = await queueWithdrawal(pool, destination.toBase58());
    await pool.query("COMMIT");
    await assert.rejects(
      assertMarketOpen(pool),
      (e) => (e as { status: number }).status === 503,
    );
    await assert.rejects(
      queueWithdrawal(pool, destination.toBase58()),
      (e) => (e as { status: number }).status === 409,
    );
    const pending = randomUUID();
    await pool.query(
      "INSERT INTO artemi_attempts(id,kind,wallet,mint,bag_id,status,message,transaction_base64,last_valid_height,payload) VALUES($1,'claim',$2,$3,$4,'submitted','message','bytes',100,'{}')",
      [pending, destination.toBase58(), mint.toBase58(), reserved],
    );
    assert.equal(
      await initializeWithdrawal(pool),
      null,
      "Must wait for in-flight claims",
    );
    assert.equal(
      (await pool.query("SELECT count(*) FROM artemi_withdrawal_items")).rows[0]
        .count,
      0,
    );
    assert.equal(
      reconciliationAction({ confirmationStatus: "confirmed" }, 999, 100),
      "wait",
    );
    await pool.query(
      "UPDATE artemi_attempts SET status='expired' WHERE id=$1",
      [pending],
    );
    assert.equal((await initializeWithdrawal(pool))?.id, batch.id);
    await assert.rejects(
      resumeMarket(request("resume", {}, cookie)),
      (e) => (e as { status: number }).status === 409,
    );
    const amount = 200000000000n,
      instructions = emergencyInstructions(
        mint,
        destination,
        amount,
        6,
        owner.publicKey,
      );
    const transfer = decodeTransferCheckedInstruction(
      instructions.at(-1)!,
      TOKEN_2022_PROGRAM_ID,
    );
    assert.equal(transfer.data.amount, amount);
    assert.equal(transfer.data.decimals, 6);
    assert.ok(transfer.keys.owner.pubkey.equals(owner.publicKey));
    assert.ok(
      transfer.keys.destination.pubkey.equals(
        getAssociatedTokenAddressSync(
          mint,
          destination,
          false,
          TOKEN_2022_PROGRAM_ID,
        ),
      ),
    );
    const tx = new VersionedTransaction(
      new TransactionMessage({
        payerKey: owner.publicKey,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions,
      }).compileToV0Message(),
    );
    tx.sign([owner]);
    assert.equal(tx.message.header.numRequiredSignatures, 1);
    assert.ok(tx.serialize().length < 1232);
    const withdrawal = randomUUID();
    await pool.query(
      "INSERT INTO artemi_attempts(id,kind,wallet,mint,status,message,transaction_base64,last_valid_height,payload,signature) VALUES($1,'withdrawal',$2,$3,'submitted','m','t',100,$4,'withdraw-proof')",
      [
        withdrawal,
        destination.toBase58(),
        mint.toBase58(),
        JSON.stringify({ batchId: batch.id, amount: amount.toString() }),
      ],
    );
    await pool.query(
      "UPDATE artemi_withdrawal_items SET status='processing',attempt_id=$2 WHERE batch_id=$1",
      [batch.id, withdrawal],
    );
    const a = {
      id: withdrawal,
      mint: mint.toBase58(),
      payload: { batchId: batch.id, amount: amount.toString() },
    };
    await pool.query("BEGIN");
    await finalizeWithdrawal(pool, a);
    await pool.query("ROLLBACK");
    assert.equal(
      (
        await pool.query("SELECT status FROM artemi_bags WHERE id=$1", [
          available,
        ])
      ).rows[0].status,
      "available",
    );
    await pool.query("BEGIN");
    await finalizeWithdrawal(pool, a);
    await pool.query(
      "UPDATE artemi_attempts SET status='finalized' WHERE id=$1",
      [withdrawal],
    );
    await pool.query("COMMIT");
    assert.equal(
      (
        await pool.query("SELECT status FROM artemi_bags WHERE id=$1", [
          claimed,
        ])
      ).rows[0].status,
      "claimed",
    );
    assert.equal(
      (
        await pool.query(
          "SELECT count(*) FROM artemi_bags WHERE status='withdrawn'",
        )
      ).rows[0].count,
      2,
    );
    assert.equal(
      (await pool.query("SELECT withdrawn_amount FROM artemi_coins")).rows[0]
        .withdrawn_amount,
      "200000000000",
    );
    await assert.rejects(
      finalizeWithdrawal(pool, a),
      "Duplicate finalization must not increment accounting",
    );
    assert.equal((await projectActivity(pool)).events.length, 1);
    assert.equal((await projectActivity(pool)).events[0].kind, "withdrawal");
    assert.equal(reservedRewards({treasury_amount:'300000000000',claimed:1,decimals:6,withdrawn_amount:'400000000000'} as Coin),0n,'External donations must not cause a negative reserved balance');
    await pool.query('BEGIN');
    await pool.query('UPDATE artemi_coins SET withdrawn_amount=0,rewards_withdrawn=false');
    await retireEmptyTreasury(pool,batch.id,mint.toBase58());
    const emptied=(await pool.query('SELECT * FROM artemi_coins')).rows[0];
    assert.equal(emptied.withdrawn_amount,'0','An empty treasury must not invent a transfer');
    assert.equal(reservedRewards({...emptied,claimed:1}),0n);
    await pool.query('ROLLBACK');
    await pool.query(
      "UPDATE artemi_withdrawals SET status='completed' WHERE id=$1",
      [batch.id],
    );
    await resumeMarket(request("resume", {}, cookie));
    await assertMarketOpen(pool);
    await adminLogout(request("logout", {}, cookie));
    await assert.rejects(
      adminSession(request("status", undefined, cookie)),
      (e) => (e as { status: number }).status === 401,
    );
  } finally {
    await pg.close();
    delete (globalThis as unknown as { artemiPool?: Pool }).artemiPool;
  }
});
