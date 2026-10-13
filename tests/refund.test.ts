import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import type { PoolClient, Pool } from "pg";
import { randomUUID } from "node:crypto";
import { queueCoinRefund, archiveRefundedCoin } from "../lib/coin-refund";
import { initializeWithdrawal, finalizeWithdrawal } from "../worker/emergency";
import { coinCatalog } from "../lib/catalog";
import { projectActivity } from "../lib/activity";
import { reservedRewards, type Coin } from "../lib/domain";

test("scoped refund is idempotent, keeps other coins intact, and archives only after finalization", async () => {
  const pg = new PGlite();
  const c = {
    query: async (sql: string, params?: unknown[]) => {
      const r = await pg.query(sql, params);
      return { ...r, rowCount: r.affectedRows ?? r.rows.length };
    },
  } as unknown as PoolClient;
  try {
    for (const f of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      await pg.exec(await readFile(`migrations/${f}`, "utf8"));
    for (const mint of ["refund", "keep"])
      await c.query(
        "INSERT INTO artemi_coins(mint,name,ticker,image,uri,creator,treasury_amount,decimals,launch_signature,bag_tokens) VALUES($1,$1,$1,'','','creator',100000000000,6,$1,100000)",
        [mint],
      );
    await c.query(
      "INSERT INTO artemi_locations(id,name,region,lat,lng,source) VALUES('fixture','Fixture','EU',45,3,'test')",
    );
    for (const mint of ["refund", "keep"])
      await c.query(
        "INSERT INTO artemi_bags(id,mint,location_id,amount) VALUES($1,$2,'fixture',100000000000)",
        [randomUUID(), mint],
      );
    await assert.rejects(archiveRefundedCoin(c, "refund"));
    await c.query("BEGIN");
    const batch = await queueCoinRefund(c, "refund");
    await c.query("COMMIT");
    assert.equal(batch.destination, "creator");
    assert.equal((await queueCoinRefund(c, "refund")).id, batch.id);
    await assert.rejects(queueCoinRefund(c, "keep"));
    await initializeWithdrawal(c);
    assert.deepEqual(
      (await c.query("SELECT mint FROM artemi_withdrawal_items")).rows,
      [{ mint: "refund" }],
    );
    const id = randomUUID();
    await c.query(
      "INSERT INTO artemi_attempts(id,kind,wallet,mint,status,message,transaction_base64,last_valid_height,payload,signature) VALUES($1,'withdrawal','creator','refund','submitted','','',100,$2,'refund-signature')",
      [id, JSON.stringify({ batchId: batch.id, amount: "100000000000" })],
    );
    await c.query(
      "UPDATE artemi_withdrawal_items SET status='processing',attempt_id=$1",
      [id],
    );
    await finalizeWithdrawal(c, {
      id,
      mint: "refund",
      payload: { batchId: batch.id, amount: "100000000000" },
    });
    await assert.rejects(archiveRefundedCoin(c, "refund"));
    await c.query("UPDATE artemi_attempts SET status='finalized' WHERE id=$1", [
      id,
    ]);
    await c.query(
      "UPDATE artemi_withdrawals SET status='completed' WHERE id=$1",
      [batch.id],
    );
    assert.equal((await projectActivity(c as unknown as Pool)).total, 1);
    await c.query("BEGIN");
    await archiveRefundedCoin(c, "refund");
    await c.query("COMMIT");
    const catalog = await coinCatalog(c as unknown as Pool, {});
    assert.equal(catalog.total, 1);
    assert.equal(catalog.totalCoins, 1);
    assert.equal(catalog.totalBags, 1);
    assert.equal(catalog.coins[0].mint, "keep");
    assert.equal((await projectActivity(c as unknown as Pool)).total, 0);
    assert.equal(
      (await c.query("SELECT paused FROM artemi_controls")).rows[0].paused,
      false,
    );
    assert.equal(
      (await c.query("SELECT count(*) FROM artemi_attempts")).rows[0].count,
      1,
      "Audit evidence is retained",
    );
    assert.equal(
      reservedRewards({
        treasury_amount: "300000000000",
        claimed: 1,
        decimals: 6,
        bag_tokens: "100000",
      } as Coin),
      200000000000n,
      "Historical bags retain their original accounting",
    );
  } finally {
    await pg.close();
  }
});
