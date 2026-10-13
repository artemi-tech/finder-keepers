import assert from "node:assert/strict";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  AccountLayout,
  MintLayout,
} from "@solana/spl-token";
import { buildLaunchV1, rpc } from "../lib/chain";
import { simulateWire } from "../lib/wire";
import { parseSol } from "../lib/domain";
console.log("RPC version", await rpc().getVersion());
const largest = await rpc().getLargestAccounts();
let payer: PublicKey | undefined;
for (const a of largest.value) {
  if (!PublicKey.isOnCurve(a.address.toBytes())) continue;
  const info = await rpc().getAccountInfo(a.address);
  if (info?.owner.equals(SystemProgram.programId)) {
    payer = a.address;
    break;
  }
}
if (!payer) throw new Error("No simulation payer found.");
const built = await buildLaunchV1(
  payer,
  {
    name: "A".repeat(32),
    ticker: "B".repeat(10),
    uri: "https://ipfs.io/ipfs/bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
  parseSol(process.argv[2] || "1"),
);
const mint = new PublicKey(built.mint),
  creator = getAssociatedTokenAddressSync(
    mint,
    payer,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
const sim = await simulateWire(built.transaction, [
  built.mint,
  creator.toBase58(),
  built.treasuryAccount,
]);
console.log(
  JSON.stringify({
    packetBytes: built.bytes,
    limit: 4096,
    error: sim.value.err,
    units: String(sim.value.unitsConsumed),
    dataBytes: String(sim.value.loadedAccountsDataSize),
    treasuryTokens: built.quote.reward.toString(),
    creatorTokens: (built.quote.amount - built.quote.reward).toString(),
    bagSize: built.quote.bags.size.toString(),
    bags: built.quote.bags.count,
    logs: sim.value.err ? sim.value.logs?.slice(-6) : undefined,
  }),
);
assert.equal(
  sim.value.err,
  null,
  "Full atomic v1 launch must simulate successfully",
);
const [m, c, t] = sim.value.accounts!;
assert.ok(m && c && t);
assert.equal(m.owner, TOKEN_2022_PROGRAM_ID.toBase58());
assert.equal(
  MintLayout.decode(Buffer.from(m.data[0], "base64").subarray(0, 82)).decimals,
  6,
);
assert.equal(
  AccountLayout.decode(Buffer.from(c.data[0], "base64").subarray(0, 165))
    .amount,
  built.quote.amount - built.quote.reward,
);
assert.equal(
  AccountLayout.decode(Buffer.from(t.data[0], "base64").subarray(0, 165))
    .amount,
  built.quote.reward,
);
console.log(
  "PASS: one atomic transaction creates the mint, buys tokens, and funds treasury exactly; no transaction broadcast.",
);
