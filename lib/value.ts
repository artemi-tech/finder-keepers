import { createRequire } from "node:module";
import { PublicKey } from "@solana/web3.js";
import { getMint, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";
import { rpc } from "./chain";
import { db } from "./db";
import { fail } from "./http";
const { OnlinePumpSdk, getSellSolAmountFromTokenAmount } = createRequire(
  import.meta.url,
)("@nirholas/pump-sdk") as typeof import("@nirholas/pump-sdk");
type Value = { lamports: string | null; updatedAt: string; basis: string };
const cache = new Map<string, { expires: number; value: Value }>();
export async function dropValue(mint: string): Promise<Value> {
  if (!mint || mint.length > 50) fail("Invalid mint.");
  const coin = (
    await db().query(
      "SELECT decimals,bag_tokens FROM artemi_coins WHERE mint=$1 AND archived_at IS NULL",
      [mint],
    )
  ).rows[0];
  if (!coin) fail("Coin not found.", 404);
  const saved = cache.get(mint);
  if (saved && saved.expires > Date.now()) return saved.value;
  let value: Value = {
    lamports: null,
    updatedAt: new Date().toISOString(),
    basis: "Market quote unavailable",
  };
  try {
    const key = new PublicKey(mint),
      sdk = new OnlinePumpSdk(rpc());
    const [global, feeConfig, curve, supply] = await Promise.all([
      sdk.fetchGlobal(),
      sdk.fetchFeeConfig(),
      sdk.fetchBondingCurve(key),
      getMint(rpc(), key, "confirmed", TOKEN_2022_PROGRAM_ID),
    ]);
    if (!curve.complete) {
      const amount = new BN(
        (BigInt(coin.bag_tokens) * 10n ** BigInt(coin.decimals)).toString(),
      );
      const estimate = getSellSolAmountFromTokenAmount({
        global,
        feeConfig,
        mintSupply: new BN(supply.supply.toString()),
        bondingCurve: curve,
        amount,
      });
      value = {
        lamports: estimate.toString(),
        updatedAt: new Date().toISOString(),
        basis:
          "Estimated bonding-curve sell value after protocol fees; excludes network costs and price movement",
      };
    }
  } catch {
    /* A missing market quote is not a zero-value reward. */
  }
  if (cache.size > 1000) cache.clear();
  cache.set(mint, { expires: Date.now() + 30000, value });
  return value;
}
