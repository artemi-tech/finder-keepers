import { PublicKey } from "@solana/web3.js";
import { db, transaction } from "../lib/db";
import { archiveRefundedCoin } from "../lib/coin-refund";
const mint = new PublicKey(process.argv[2]).toBase58();
try {
  await transaction((c) => archiveRefundedCoin(c, mint));
  console.log(JSON.stringify({ mint, archived: true }));
} finally {
  await db().end();
}
