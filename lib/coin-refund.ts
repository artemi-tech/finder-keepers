import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

// Operator-only procedure; deliberately not exposed as a public API.
// Caller must wrap this in a database transaction. The worker signs and reconciles.
export async function queueCoinRefund(
  c: Pick<PoolClient, "query">,
  mint: string,
) {
  const control = (
    await c.query("SELECT * FROM artemi_controls WHERE id=1 FOR UPDATE")
  ).rows[0];
  if (!control) throw new Error("Treasury controls unavailable.");
  const coin = (
    await c.query(
      "SELECT creator,rewards_withdrawn FROM artemi_coins WHERE mint=$1 FOR UPDATE",
      [mint],
    )
  ).rows[0];
  if (!coin) throw new Error("Coin not found.");
  const previous = (
    await c.query(
      "SELECT w.id,w.destination,w.status FROM artemi_withdrawals w JOIN artemi_withdrawal_items i ON i.batch_id=w.id WHERE i.mint=$1 AND w.destination=$2 ORDER BY w.created_at DESC LIMIT 1",
      [mint, coin.creator],
    )
  ).rows[0];
  if (previous) return previous;
  if (coin.rewards_withdrawn) throw new Error("Rewards already withdrawn.");
  if (
    control.paused ||
    (
      await c.query(
        "SELECT 1 FROM artemi_withdrawals WHERE status IN ('waiting','running')",
      )
    ).rowCount
  )
    throw new Error("Another treasury operation is active.");
  // 'running' with one explicit item prevents the all-coin initializer from expanding scope.
  const id = randomUUID();
  await c.query(
    "INSERT INTO artemi_withdrawals(id,destination,status) VALUES($1,$2,'running')",
    [id, coin.creator],
  );
  await c.query(
    "INSERT INTO artemi_withdrawal_items(batch_id,mint) VALUES($1,$2)",
    [id, mint],
  );
  await c.query(
    "UPDATE artemi_controls SET paused=true,withdrawal_id=$1 WHERE id=1",
    [id],
  );
  return { id, destination: coin.creator, status: "running" };
}

export async function archiveRefundedCoin(
  c: Pick<PoolClient, "query">,
  mint: string,
) {
  const control = (
    await c.query("SELECT * FROM artemi_controls WHERE id=1 FOR UPDATE")
  ).rows[0];
  const coin = (
    await c.query("SELECT * FROM artemi_coins WHERE mint=$1 FOR UPDATE", [mint])
  ).rows[0];
  if (!coin?.rewards_withdrawn)
    throw new Error("Refund must finalize before archiving.");
  if (coin.archived_at) return;
  const batch = (
    await c.query(
      "SELECT w.id FROM artemi_withdrawals w JOIN artemi_withdrawal_items i ON i.batch_id=w.id JOIN artemi_attempts a ON a.id=i.attempt_id WHERE i.mint=$1 AND w.destination=$2 AND w.status='completed' AND i.status='finalized' AND a.status='finalized' ORDER BY w.created_at DESC LIMIT 1",
      [mint, coin.creator],
    )
  ).rows[0];
  if (!batch || control?.withdrawal_id !== batch.id)
    throw new Error(
      "Completed creator refund must be the current treasury operation.",
    );
  if (
    (
      await c.query(
        "SELECT 1 FROM artemi_bags WHERE mint=$1 AND status IN ('available','reserved')",
        [mint],
      )
    ).rowCount
  )
    throw new Error("Rewards are still active.");
  await c.query("UPDATE artemi_coins SET archived_at=now() WHERE mint=$1", [
    mint,
  ]);
  await c.query(
    "UPDATE artemi_attempts SET archived_at=now() WHERE mint=$1 OR (kind='launch' AND wallet=$2 AND payload->>'name'=$3 AND payload->>'ticker'=$4 AND payload->>'image'=$5 AND status IN ('failed','expired'))",
    [mint, coin.creator, coin.name, coin.ticker, coin.image],
  );
  await c.query(
    "UPDATE artemi_controls SET paused=false,withdrawal_id=NULL WHERE id=1",
  );
}
