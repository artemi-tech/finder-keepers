import {
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  AddressLookupTableProgram,
  AddressLookupTableAccount,
  SystemProgram,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "@solana/spl-token";
import { createRequire } from "node:module";
// The pinned SDK's ESM entry imports named exports from its CommonJS dependency.
// Load its supported CommonJS entry consistently on Node and Vercel.
const {
  OnlinePumpSdk,
  PUMP_SDK,
  newBondingCurve,
  getBuySolAmountFromTokenAmount,
  PUMP_PROGRAM_ID,
  GLOBAL_PDA,
  PUMP_EVENT_AUTHORITY_PDA,
  MAYHEM_PROGRAM_ID,
  getGlobalParamsPda,
  getSolVaultPda,
  PUMP_FEE_PROGRAM_ID,
  PUMP_FEE_CONFIG_PDA,
} = createRequire(import.meta.url)(
  "@nirholas/pump-sdk",
) as typeof import("@nirholas/pump-sdk");
import BN from "bn.js";
import { principalTokens, TREASURY_PRINCIPAL, partition } from "./domain";
import { compileV1, encodeWire, wireMessage } from "./wire";
let connection: Connection | undefined;
export function rpc() {
  if (!connection) {
    if (!process.env.SOLANA_HTTPS_ENDPOINT) throw new Error("RPC unavailable.");
    connection = new Connection(process.env.SOLANA_HTTPS_ENDPOINT, {
      commitment: "confirmed",
      wsEndpoint: process.env.SOLANA_WSS_ENDPOINT,
      disableRetryOnRateLimit: true,
    });
  }
  return connection;
}
export function treasury() {
  if (!process.env.ARTEMI_TREASURY_PUBLIC_KEY)
    throw new Error("Treasury unavailable.");
  return new PublicKey(process.env.ARTEMI_TREASURY_PUBLIC_KEY);
}
export const DECIMALS = 6;
export async function quoteLaunch(principal: bigint) {
  const sdk = new OnlinePumpSdk(rpc());
  const [global, feeConfig] = await Promise.all([
    sdk.fetchGlobal(),
    sdk.fetchFeeConfig(),
  ]);
  if (!global.createV2Enabled)
    throw new Error("pump.fun token creation is currently unavailable.");
  const amount = principalTokens(
    principal,
    BigInt(global.initialVirtualSolReserves.toString()),
    BigInt(global.initialVirtualTokenReserves.toString()),
    BigInt(global.initialRealTokenReserves.toString()),
  );
  const reward = principalTokens(
    TREASURY_PRINCIPAL,
    BigInt(global.initialVirtualSolReserves.toString()),
    BigInt(global.initialVirtualTokenReserves.toString()),
    BigInt(global.initialRealTokenReserves.toString()),
  );
  const cost = getBuySolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: new BN(amount.toString()),
  });
  return {
    global,
    feeConfig,
    amount,
    reward,
    cost: BigInt(cost.toString()),
    bags: partition(reward, DECIMALS),
  };
}
export const lookupAddresses = () => [
  SystemProgram.programId,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  PUMP_PROGRAM_ID,
  GLOBAL_PDA,
  PUMP_EVENT_AUTHORITY_PDA,
  MAYHEM_PROGRAM_ID,
  getGlobalParamsPda(),
  getSolVaultPda(),
  PUMP_FEE_PROGRAM_ID,
  PUMP_FEE_CONFIG_PDA,
  treasury(),
];
export async function buildLookup(user: PublicKey) {
  const latest = await rpc().getLatestBlockhash("confirmed");
  const slot = await rpc().getSlot("finalized");
  const [create, address] = AddressLookupTableProgram.createLookupTable({
    authority: user,
    payer: user,
    recentSlot: slot,
  });
  const extend = AddressLookupTableProgram.extendLookupTable({
    authority: user,
    payer: user,
    lookupTable: address,
    addresses: lookupAddresses(),
  });
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: user,
      recentBlockhash: latest.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }),
        create,
        extend,
      ],
    }).compileToV0Message(),
  );
  return { tx, latest, address };
}
export async function launchInstructions(
  user: PublicKey,
  metadata: { name: string; ticker: string; uri: string },
  principal: bigint,
) {
  const quote = await quoteLaunch(principal);
  const mint = Keypair.generate();
  const latest = await rpc().getLatestBlockhash("confirmed");
  const curve = newBondingCurve(quote.global);
  curve.creator = user;
  curve.isMayhemMode = false;
  const create = await PUMP_SDK.createV2Instruction({
    mint: mint.publicKey,
    name: metadata.name,
    symbol: metadata.ticker,
    uri: metadata.uri,
    creator: user,
    user,
    mayhemMode: false,
    cashback: false,
    holderReward: false,
  });
  const buys = await PUMP_SDK.buyV3Instructions({
    bondingCurve: curve,
    associatedUserAccountInfo: null,
    mint: mint.publicKey,
    user,
    amount: new BN(quote.amount.toString()),
    quoteAmount: new BN(quote.cost.toString()),
    slippage: 0,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    partialFill: false,
  });
  const from = getAssociatedTokenAddressSync(
    mint.publicKey,
    user,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const to = getAssociatedTokenAddressSync(
    mint.publicKey,
    treasury(),
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }),
    create,
    ...buys,
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      to,
      treasury(),
      mint.publicKey,
      TOKEN_2022_PROGRAM_ID,
    ),
    createTransferCheckedInstruction(
      from,
      mint.publicKey,
      to,
      user,
      quote.reward,
      DECIMALS,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  ];
  return { instructions, mint, latest, quote, to };
}
export async function buildLaunch(
  user: PublicKey,
  metadata: { name: string; ticker: string; uri: string },
  principal: bigint,
  lookup?: AddressLookupTableAccount,
) {
  const { instructions, mint, latest, quote, to } = await launchInstructions(
    user,
    metadata,
    principal,
  );
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: user,
      recentBlockhash: latest.blockhash,
      instructions,
    }).compileToV0Message(lookup ? [lookup] : []),
  );
  tx.sign([mint]);
  const bytes = tx.serialize();
  if (bytes.length > 1232)
    throw new Error(
      "Launch exceeds the transaction size limit. Shorten the name or ticker.",
    );
  return {
    tx,
    latest,
    quote,
    mint: mint.publicKey.toBase58(),
    treasuryAccount: to.toBase58(),
    bytes: bytes.length,
  };
}
export async function buildLaunchV1(
  user: PublicKey,
  metadata: { name: string; ticker: string; uri: string },
  principal: bigint,
) {
  const { instructions, mint, latest, quote, to } = await launchInstructions(
    user,
    metadata,
    principal,
  );
  const tx = compileV1(
    user,
    latest,
    instructions.filter(
      (i) => !i.programId.equals(ComputeBudgetProgram.programId),
    ),
    mint,
  );
  return {
    transaction: encodeWire(tx),
    message: wireMessage(tx),
    latest,
    quote,
    mint: mint.publicKey.toBase58(),
    treasuryAccount: to.toBase58(),
    bytes: Buffer.from(encodeWire(tx), "base64").length,
  };
}
/**
 * Two authorities sign one message: user pays SOL fees/ATA rent; treasury
 * authorizes the token transfer. Broadcasting by the worker does not change
 * the fee payer. See docs/TREASURY.md for the account and custody model.
 */
export async function buildClaim(
  user: PublicKey,
  mint: PublicKey,
  amount: bigint,
  decimals: number,
) {
  const from = getAssociatedTokenAddressSync(
      mint,
      treasury(),
      false,
      TOKEN_2022_PROGRAM_ID,
    ),
    to = getAssociatedTokenAddressSync(
      mint,
      user,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
  const latest = await rpc().getLatestBlockhash("confirmed");
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 80000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      user,
      to,
      user,
      mint,
      TOKEN_2022_PROGRAM_ID,
    ),
    createTransferCheckedInstruction(
      from,
      mint,
      to,
      treasury(),
      amount,
      decimals,
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  ];
  return {
    tx: new VersionedTransaction(
      new TransactionMessage({
        payerKey: user,
        recentBlockhash: latest.blockhash,
        instructions,
      }).compileToV0Message(),
    ),
    latest,
  };
}
