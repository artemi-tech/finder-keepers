import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  ComputeBudgetInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  address,
  decompileTransactionMessage,
  getCompiledTransactionMessageDecoder,
} from "@solana/kit";
import {
  compileV1,
  decodeWire,
  encodeWire,
  wireMessage,
  validateWalletWire,
  signWire,
  restoreCoSignatures,
  verifyWireSignatures,
  wireSignature,
} from "../lib/wire";
import { buildLookup, rpc } from "../lib/chain";
test("v1 packet preserves exact message, mint signature, resource limits and wallet signature across every handoff", () => {
  const user = Keypair.generate(),
    mint = Keypair.generate(),
    destination = Keypair.generate().publicKey;
  const tx = compileV1(
    user.publicKey,
    {
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    },
    [
      SystemProgram.transfer({
        fromPubkey: mint.publicKey,
        toPubkey: destination,
        lamports: 1234,
      }),
    ],
    mint,
  );
  const prepared = encodeWire(tx),
    decoded = decodeWire(prepared),
    compiled = getCompiledTransactionMessageDecoder().decode(
      decoded.messageBytes,
    ),
    message = decompileTransactionMessage(compiled);
  assert.equal(message.version, 1);
  assert.ok("config" in message);
  assert.ok(message.config);
  assert.equal(message.config.computeUnitLimit, 600000);
  assert.equal(message.config.priorityFeeLamports, 6000n);
  assert.ok(message.config.loadedAccountsDataSizeLimit! > 0);
  const walletOnly = signWire(
    {
      ...decoded,
      signatures: {
        ...decoded.signatures,
        [address(mint.publicKey.toBase58())]: null,
      },
    },
    user,
  );
  const validated = validateWalletWire(
    wireMessage(tx),
    encodeWire(walletOnly),
    user.publicKey.toBase58(),
  );
  const restored = restoreCoSignatures(
    validated,
    decoded,
    user.publicKey.toBase58(),
  );
  verifyWireSignatures(restored);
  const submitted = decodeWire(encodeWire(restored));
  assert.equal(wireMessage(submitted), wireMessage(tx));
  assert.equal(wireSignature(submitted), wireSignature(restored));
  assert.equal(Buffer.from(encodeWire(submitted), "base64")[0], 129);
  const changed = compileV1(
    user.publicKey,
    {
      blockhash: Keypair.generate().publicKey.toBase58(),
      lastValidBlockHeight: 100,
    },
    [
      SystemProgram.transfer({
        fromPubkey: mint.publicKey,
        toPubkey: destination,
        lamports: 9999,
      }),
    ],
    mint,
  );
  assert.throws(
    () =>
      validateWalletWire(
        wireMessage(tx),
        encodeWire(signWire(changed, user)),
        user.publicKey.toBase58(),
      ),
    /changed/,
  );
  assert.throws(
    () =>
      validateWalletWire(wireMessage(tx), prepared, user.publicKey.toBase58()),
    /signature/,
  );
  assert.throws(
    () => restoreCoSignatures(restored, changed, user.publicKey.toBase58()),
    /mismatch/,
  );
});
test("lookup setup supplies explicit fees so wallets need not rewrite its message", async () => {
  process.env.SOLANA_HTTPS_ENDPOINT = "http://127.0.0.1:1";
  process.env.ARTEMI_TREASURY_PUBLIC_KEY =
    Keypair.generate().publicKey.toBase58();
  const connection = rpc(),
    getSlot = connection.getSlot,
    getHash = connection.getLatestBlockhash;
  connection.getSlot = async () => 123;
  connection.getLatestBlockhash = async () => ({
    blockhash: Keypair.generate().publicKey.toBase58(),
    lastValidBlockHeight: 300,
  });
  try {
    const user = Keypair.generate(),
      built = await buildLookup(user.publicKey),
      instructions = TransactionMessage.decompile(
        built.tx.message,
      ).instructions;
    assert.equal(
      instructions.filter((i) =>
        i.programId.equals(ComputeBudgetProgram.programId),
      ).length,
      2,
    );
    assert.equal(
      ComputeBudgetInstruction.decodeSetComputeUnitLimit(instructions[0]).units,
      100000,
    );
    assert.equal(
      ComputeBudgetInstruction.decodeSetComputeUnitPrice(instructions[1])
        .microLamports,
      10000n,
    );
    built.tx.sign([user]);
    const signed = Buffer.from(built.tx.serialize()).toString("base64");
    verifyWireSignatures(
      validateWalletWire(
        Buffer.from(built.tx.message.serialize()).toString("base64"),
        signed,
        user.publicKey.toBase58(),
      ),
    );
  } finally {
    connection.getSlot = getSlot;
    connection.getLatestBlockhash = getHash;
  }
});
