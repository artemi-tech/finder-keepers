import {
  address,
  blockhash,
  createTransactionMessage,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  setTransactionMessageConfig,
  appendTransactionMessageInstructions,
  compileTransaction,
  getTransactionDecoder,
  getTransactionEncoder,
  getCompiledTransactionMessageDecoder,
  createSolanaRpc,
  signature,
  type Transaction,
  type SignatureBytes,
  type Base64EncodedWireTransaction,
} from "@solana/kit";
import type {
  Keypair,
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { fail, HttpError } from "./http";
import { hasOnlyWalletGuards } from "./wallet-guards";
export class WalletMessageMismatch extends HttpError {
  constructor(public receivedMessage: string) {
    super(
      400,
      "Your wallet changed the transaction. Nothing was submitted by Artemi. The diagnostic has been saved for investigation.",
    );
  }
}
export function decodeWire(encoded: string): Transaction {
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > 4096) fail("Transaction exceeds the supported size.");
  try {
    return getTransactionDecoder().decode(bytes);
  } catch {
    fail("Invalid transaction.");
  }
}
export const encodeWire = (tx: Transaction) =>
  Buffer.from(getTransactionEncoder().encode(tx)).toString("base64");
export const wireMessage = (tx: Transaction) =>
  Buffer.from(tx.messageBytes).toString("base64");
export function validateWalletWire(
  expected: string,
  encoded: string,
  wallet: string,
  allowGuards = false,
) {
  const tx = decodeWire(encoded),
    compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const sig = tx.signatures[address(wallet)];
  if (
    compiled.staticAccounts[0] !== wallet ||
    !sig ||
    !nacl.sign.detached.verify(
      new Uint8Array(tx.messageBytes),
      new Uint8Array(sig),
      bs58.decode(wallet),
    )
  )
    fail("Invalid wallet signature.");
  if (
    wireMessage(tx) !== expected &&
    !(allowGuards && hasOnlyWalletGuards(expected, wireMessage(tx)))
  )
    throw new WalletMessageMismatch(wireMessage(tx));
  return tx;
}
export function signWire(tx: Transaction, key: Keypair): Transaction {
  const owner = address(key.publicKey.toBase58());
  if (!(owner in tx.signatures)) throw new Error("Unexpected signer.");
  return {
    ...tx,
    signatures: {
      ...tx.signatures,
      [owner]: nacl.sign.detached(
        new Uint8Array(tx.messageBytes),
        key.secretKey,
      ) as SignatureBytes,
    },
  };
}
export function restoreCoSignatures(
  tx: Transaction,
  original: Transaction,
  wallet: string,
): Transaction {
  if (wireMessage(tx) !== wireMessage(original))
    throw new Error("Stored message mismatch.");
  const signatures = { ...tx.signatures };
  for (const [owner, sig] of Object.entries(original.signatures))
    if (owner !== wallet && sig && sig.some((n) => n !== 0))
      signatures[address(owner)] = sig;
  return { ...tx, signatures };
}
export function verifyWireSignatures(tx: Transaction) {
  for (const [owner, sig] of Object.entries(tx.signatures))
    if (
      !sig ||
      !nacl.sign.detached.verify(
        new Uint8Array(tx.messageBytes),
        new Uint8Array(sig),
        bs58.decode(owner),
      )
    )
      throw new Error("Invalid signer.");
}
export function wireSignature(tx: Transaction) {
  const sig = Object.values(tx.signatures)[0];
  if (!sig) throw new Error("Missing payer signature.");
  return bs58.encode(new Uint8Array(sig));
}
export function compileV1(
  payer: PublicKey,
  latest: { blockhash: string; lastValidBlockHeight: number },
  instructions: TransactionInstruction[],
  mint: Keypair,
) {
  const message = setTransactionMessageConfig(
    {
      computeUnitLimit: 600000,
      loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
      priorityFeeLamports: 6000n,
    },
    appendTransactionMessageInstructions(
      instructions.map((i) => ({
        programAddress: address(i.programId.toBase58()),
        accounts: i.keys.map((k) => ({
          address: address(k.pubkey.toBase58()),
          role: (k.isSigner ? 2 : 0) | (k.isWritable ? 1 : 0),
        })),
        data: i.data,
      })),
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(latest.blockhash),
          lastValidBlockHeight: BigInt(latest.lastValidBlockHeight),
        },
        setTransactionMessageFeePayer(
          address(payer.toBase58()),
          createTransactionMessage({ version: 1 }),
        ),
      ),
    ),
  );
  const tx = signWire(compileTransaction(message), mint);
  if (getTransactionEncoder().encode(tx).length > 4096)
    throw new Error("Launch exceeds the transaction size limit.");
  return tx;
}
function wireRpc() {
  const url = process.env.SOLANA_HTTPS_ENDPOINT;
  if (!url) throw new Error("RPC unavailable.");
  return createSolanaRpc(url);
}
export const simulateWire = (encoded: string, accounts: string[] = []) =>
  wireRpc()
    .simulateTransaction(encoded as Base64EncodedWireTransaction, {
      encoding: "base64",
      sigVerify: false,
      commitment: "confirmed",
      accounts: {
        encoding: "base64",
        addresses: accounts.map((a) => address(a)),
      },
    })
    .send();
export const finalizedWire = (sig: string) =>
  wireRpc()
    .getTransaction(signature(sig), {
      encoding: "base64",
      commitment: "finalized",
      maxSupportedTransactionVersion: 1,
    })
    .send();
export const broadcastWire = (encoded: string) =>
  wireRpc()
    .sendTransaction(encoded as Base64EncodedWireTransaction, {
      encoding: "base64",
      skipPreflight: false,
      maxRetries: 0n,
      preflightCommitment: "confirmed",
    })
    .send();
