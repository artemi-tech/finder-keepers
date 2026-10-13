import { PublicKey } from "@solana/web3.js";
import { db, transaction } from "../lib/db";
import { rpc, treasury } from "../lib/chain";
import { queueCoinRefund } from "../lib/coin-refund";

const mint = new PublicKey(process.argv[2]).toBase58();
try {
  const balance = await rpc().getBalance(treasury(), "finalized");
  if (balance < 6000)
    throw new Error("Treasury needs SOL for transaction fees.");
  console.log(
    JSON.stringify(await transaction((c) => queueCoinRefund(c, mint))),
  );
} finally {
  await db().end();
}
