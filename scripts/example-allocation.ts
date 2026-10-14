/** Offline fixture, not a live quote. No credentials, RPC calls or asset transfers. */
import {
  parseSol,
  principalTokens,
  partition,
  TREASURY_PRINCIPAL,
} from "../lib/domain";

// Same initial-reserve fixture as tests/domain.test.ts. Live launches fetch reserves.
const tokensFor = (principal: bigint) =>
  principalTokens(principal, 30_000_000_000n, 1_073_000_000_000_000n, 793_100_000_000_000n);
const reward = tokensFor(TREASURY_PRINCIPAL);
const bags = partition(reward, 6);
for (const sol of ["0.2", "2"]) {
  const principal = parseSol(sol);
  console.log(JSON.stringify({
    fixture: true,
    principalLamports: principal.toString(),
    treasuryBaseUnits: reward.toString(),
    creatorBaseUnits: (tokensFor(principal) - reward).toString(),
    bagCount: bags.count,
    bagBaseUnits: bags.size.toString(),
    remainderBaseUnits: bags.remainder.toString(),
    // Protocol/network fees and rent are deliberately outside this pure example.
    costsIncluded: "curve principal only",
  }, null, 2));
}
