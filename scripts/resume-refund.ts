import { PublicKey } from "@solana/web3.js";
import { db, transaction } from "../lib/db";
const mint = new PublicKey(process.argv[2]).toBase58();
try {
  await transaction(async (c) => {
    const control = (
      await c.query("SELECT * FROM artemi_controls WHERE id=1 FOR UPDATE")
    ).rows[0];
    const proof = (
      await c.query(
        "SELECT w.id FROM artemi_withdrawals w JOIN artemi_withdrawal_items i ON i.batch_id=w.id JOIN artemi_attempts a ON a.id=i.attempt_id JOIN artemi_coins c ON c.mint=i.mint WHERE w.id=$1 AND i.mint=$2 AND w.status='completed' AND i.status='finalized' AND a.status='finalized' AND w.destination=c.creator AND c.rewards_withdrawn",
        [control?.withdrawal_id, mint],
      )
    ).rows[0];
    if (!proof)
      throw new Error("The current creator refund has not completed.");
    if (
      (
        await c.query(
          "SELECT 1 FROM artemi_withdrawals WHERE status IN ('waiting','running')",
        )
      ).rowCount
    )
      throw new Error("Another withdrawal is active.");
    await c.query(
      "UPDATE artemi_controls SET paused=false,withdrawal_id=NULL WHERE id=1",
    );
  });
  console.log(JSON.stringify({ mint, marketResumed: true }));
} finally {
  await db().end();
}
