import { PublicKey } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { db } from "../lib/db";
import { rpc, treasury } from "../lib/chain";
import { finalizedWire } from "../lib/wire";

const mint = new PublicKey(process.argv[2]);
try {
  const a = (
    await db().query(
      "SELECT a.signature,a.wallet,a.payload,i.batch_id,w.status AS batch_status FROM artemi_attempts a JOIN artemi_withdrawal_items i ON i.attempt_id=a.id JOIN artemi_withdrawals w ON w.id=i.batch_id JOIN artemi_coins c ON c.mint=a.mint WHERE a.mint=$1 AND a.kind='withdrawal' AND a.status='finalized' AND a.wallet=c.creator ORDER BY a.created_at DESC LIMIT 1",
      [mint.toBase58()],
    )
  ).rows[0];
  if (!a) throw new Error("No finalized creator refund.");
  const chain = await finalizedWire(a.signature);
  if (!chain?.meta || chain.meta.err)
    throw new Error("Finalized chain proof unavailable.");
  const delta = (owner: string) => {
    const sum = (balances: typeof chain.meta.postTokenBalances) =>
      (balances || [])
        .filter((b) => b.mint === mint.toBase58() && b.owner === owner)
        .reduce((n, b) => n + BigInt(b.uiTokenAmount.amount), 0n);
    return (
      sum(chain.meta!.postTokenBalances) - sum(chain.meta!.preTokenBalances)
    );
  };
  const amount = BigInt(a.payload.amount);
  if (delta(a.wallet) !== amount || delta(treasury().toBase58()) !== -amount)
    throw new Error("Refund balance mismatch.");
  const account = getAssociatedTokenAddressSync(
    mint,
    treasury(),
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const remaining = (await rpc().getTokenAccountBalance(account, "finalized"))
    .value.amount;
  if (remaining !== "0") throw new Error("Treasury still holds this coin.");
  console.log(
    JSON.stringify({
      mint: mint.toBase58(),
      destination: a.wallet,
      amount: amount.toString(),
      treasuryRemaining: remaining,
      signature: a.signature,
      batch: a.batch_id,
      status: a.batch_status,
    }),
  );
} finally {
  await db().end();
}
