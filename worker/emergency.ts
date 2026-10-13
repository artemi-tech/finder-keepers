import { randomUUID } from "node:crypto";
import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  TOKEN_2022_PROGRAM_ID,
  TokenAccountNotFoundError,
} from "@solana/spl-token";
import type { PoolClient } from "pg";
import { rpc, treasury } from "../lib/chain";
import { transaction } from "../lib/db";
export function emergencyInstructions(
  mint: PublicKey,
  destination: PublicKey,
  amount: bigint,
  decimals: number,
  owner = treasury(),
) {
  const from = getAssociatedTokenAddressSync(
      mint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID,
    ),
    to = getAssociatedTokenAddressSync(
      mint,
      destination,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      to,
      destination,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    createTransferCheckedInstruction(
      from,
      mint,
      to,
      owner,
      amount,
      decimals,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  ];
}
export async function initializeWithdrawal(c: Pick<PoolClient, "query">) {
  await c.query("SELECT id FROM artemi_controls WHERE id=1 FOR UPDATE");
  const batch = (
    await c.query(
      "SELECT * FROM artemi_withdrawals WHERE status IN ('waiting','running') ORDER BY created_at LIMIT 1 FOR UPDATE",
    )
  ).rows[0];
  if (!batch) return null;
  // Prepared requests may still be signed outside the API. Let their blockhashes expire;
  // queued/submitted launches and claims must reconcile before the treasury is touched.
  if (
    (
      await c.query(
        "SELECT 1 FROM artemi_attempts WHERE kind IN ('launch','claim','setup') AND status IN ('prepared','queued','submitted') LIMIT 1",
      )
    ).rowCount
  )
    return null;
  if (batch.status === "waiting") {
    await c.query(
      "INSERT INTO artemi_withdrawal_items(batch_id,mint) SELECT $1,mint FROM artemi_coins ON CONFLICT DO NOTHING",
      [batch.id],
    );
    await c.query(
      "UPDATE artemi_withdrawals SET status='running',updated_at=now() WHERE id=$1",
      [batch.id],
    );
  }
  return batch;
}
export async function finalizeWithdrawal(
  c: Pick<PoolClient, "query">,
  attempt: {
    id: string;
    mint: string;
    payload: Record<string, string | number>;
  },
) {
  const item = await c.query(
    "UPDATE artemi_withdrawal_items SET status='finalized',error=NULL WHERE batch_id=$1 AND mint=$2 AND attempt_id=$3 AND status='processing' RETURNING mint",
    [attempt.payload.batchId, attempt.mint, attempt.id],
  );
  if (!item.rowCount) throw new Error("Withdrawal item state mismatch.");
  await c.query(
    "UPDATE artemi_bags SET status='withdrawn',claimant=NULL WHERE mint=$1 AND status IN ('available','reserved')",
    [attempt.mint],
  );
  await c.query(
    "UPDATE artemi_coins SET withdrawn_amount=withdrawn_amount+$2,rewards_withdrawn=true WHERE mint=$1",
    [attempt.mint, attempt.payload.amount],
  );
}
export async function retireEmptyTreasury(
  c: Pick<PoolClient, "query">,
  batchId: string,
  mint: string,
) {
  await c.query(
    "UPDATE artemi_withdrawal_items SET status='empty',error=NULL WHERE batch_id=$1 AND mint=$2",
    [batchId, mint],
  );
  await c.query(
    "UPDATE artemi_bags SET status='withdrawn',claimant=NULL WHERE mint=$1 AND status IN ('available','reserved')",
    [mint],
  );
  await c.query(
    "UPDATE artemi_coins SET rewards_withdrawn=true WHERE mint=$1",
    [mint],
  );
}
export async function emergencyTick() {
  await transaction(async (c) => {
    const batch = await initializeWithdrawal(c);
    if (!batch) return;
    const item = (
      await c.query(
        "SELECT i.*,c.decimals FROM artemi_withdrawal_items i JOIN artemi_coins c ON c.mint=i.mint WHERE i.batch_id=$1 AND i.status IN ('pending','processing') AND i.next_retry_at<=now() ORDER BY i.next_retry_at,i.mint LIMIT 1 FOR UPDATE OF i",
        [batch.id],
      )
    ).rows[0];
    if (!item) {
      if (
        !(
          await c.query(
            "SELECT 1 FROM artemi_withdrawal_items WHERE batch_id=$1 AND status IN ('pending','processing')",
            [batch.id],
          )
        ).rowCount
      )
        await c.query(
          "UPDATE artemi_withdrawals SET status='completed',updated_at=now() WHERE id=$1",
          [batch.id],
        );
      return;
    }
    if (item.attempt_id) {
      const a = (
        await c.query("SELECT status FROM artemi_attempts WHERE id=$1", [
          item.attempt_id,
        ])
      ).rows[0];
      if (a && ["queued", "submitted", "prepared"].includes(a.status)) {
        await c.query(
          "UPDATE artemi_withdrawal_items SET next_retry_at=now()+interval '5 seconds' WHERE batch_id=$1 AND mint=$2",
          [batch.id, item.mint],
        );
        return;
      }
      if (a?.status === "finalized")
        throw new Error("Finalized withdrawal was not recorded.");
    }
    await c.query("SAVEPOINT prepare_withdrawal");
    try {
      const mint = new PublicKey(item.mint),
        from = getAssociatedTokenAddressSync(
          mint,
          treasury(),
          false,
          TOKEN_2022_PROGRAM_ID,
        );
      let amount: bigint;
      try {
        amount = (
          await getAccount(rpc(), from, "finalized", TOKEN_2022_PROGRAM_ID)
        ).amount;
      } catch (e) {
        if (e instanceof TokenAccountNotFoundError) amount = 0n;
        else throw e;
      }
      if (amount === 0n) {
        await retireEmptyTreasury(c, batch.id, item.mint);
        return;
      }
      const latest = await rpc().getLatestBlockhash("confirmed");
      const tx = new VersionedTransaction(
        new TransactionMessage({
          payerKey: treasury(),
          recentBlockhash: latest.blockhash,
          instructions: emergencyInstructions(
            mint,
            new PublicKey(batch.destination),
            amount,
            item.decimals,
          ),
        }).compileToV0Message(),
      );
      const sim = await rpc().simulateTransaction(tx, {
        sigVerify: false,
        commitment: "confirmed",
      });
      if (sim.value.err) throw new Error("Withdrawal simulation failed");
      const id = randomUUID(),
        bytes = Buffer.from(tx.serialize()).toString("base64");
      await c.query(
        "INSERT INTO artemi_attempts(id,kind,wallet,mint,status,message,transaction_base64,signed_base64,last_valid_height,payload) VALUES($1,'withdrawal',$2,$3,'queued',$4,$5,$5,$6,$7)",
        [
          id,
          batch.destination,
          item.mint,
          Buffer.from(tx.message.serialize()).toString("base64"),
          bytes,
          latest.lastValidBlockHeight,
          JSON.stringify({
            batchId: batch.id,
            amount: amount.toString(),
            decimals: item.decimals,
          }),
        ],
      );
      await c.query(
        "UPDATE artemi_withdrawal_items SET status='processing',attempt_id=$3,error=NULL,next_retry_at=now()+interval '5 seconds' WHERE batch_id=$1 AND mint=$2",
        [batch.id, item.mint, id],
      );
    } catch {
      await c.query("ROLLBACK TO SAVEPOINT prepare_withdrawal");
      await c.query(
        "UPDATE artemi_withdrawal_items SET error='Transfer preparation delayed. Check treasury SOL for fees and account rent, then check RPC availability. Retrying automatically.',tries=tries+1,next_retry_at=now()+$3*interval '1 second' WHERE batch_id=$1 AND mint=$2",
        [batch.id, item.mint, Math.min(60, 2 ** Math.min(item.tries + 1, 6))],
      );
    }
  });
}
