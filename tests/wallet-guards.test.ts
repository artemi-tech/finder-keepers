import test from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { hasOnlyWalletGuards, LIGHTHOUSE } from "../lib/wallet-guards";
import {
  validateWalletWire,
  wireMessage,
  verifyWireSignatures,
} from "../lib/wire";

test("Phantom read-only guards preserve authorization; harmful mutations never pass", () => {
  const payer = Keypair.generate(),
    destination = Keypair.generate().publicKey,
    hash = Keypair.generate().publicKey.toBase58();
  const core = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10000 }),
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: destination,
      lamports: 200,
    }),
  ];
  const guard = (target: PublicKey, opcode = 6) =>
    new TransactionInstruction({
      programId: new PublicKey(LIGHTHOUSE),
      keys: [{ pubkey: target, isSigner: false, isWritable: false }],
      data: Buffer.from([opcode, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    });
  const build = (instructions: TransactionInstruction[], blockhash = hash) => {
    const t = new VersionedTransaction(
      new TransactionMessage({
        payerKey: payer.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message(),
    );
    t.sign([payer]);
    return t;
  };
  const message = (t: VersionedTransaction) =>
    Buffer.from(t.message.serialize()).toString("base64");
  const before = build(core),
    after = build([
      ...core.slice(0, 2),
      guard(destination),
      core[2],
      guard(payer.publicKey),
    ]),
    expected = message(before);
  assert.equal(hasOnlyWalletGuards(expected, message(after)), true);
  const accepted = validateWalletWire(
    expected,
    Buffer.from(after.serialize()).toString("base64"),
    payer.publicKey.toBase58(),
    true,
  );
  assert.equal(wireMessage(accepted), message(after));
  verifyWireSignatures(accepted);
  assert.throws(
    () =>
      validateWalletWire(
        expected,
        Buffer.from(after.serialize()).toString("base64"),
        payer.publicKey.toBase58(),
      ),
    /changed/,
  );
  const altered = [
    build([...core, guard(destination, 0)]), // MemoryWrite
    build([...core, guard(destination, 1)]), // MemoryClose
    build([...core, guard(Keypair.generate().publicKey)]),
    build(
      [...core, guard(destination)],
      Keypair.generate().publicKey.toBase58(),
    ),
    build([
      ...core,
      guard(destination),
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: destination,
        lamports: 1,
      }),
    ]),
    build([core[1], core[0], core[2], guard(destination)]),
    build([
      core[0],
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 999999 }),
      core[2],
      guard(destination),
    ]),
    build([
      core[0],
      core[1],
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: destination,
        lamports: 201,
      }),
      guard(destination),
    ]),
    build([...core, ...Array.from({ length: 9 }, () => guard(destination))]),
  ];
  for (const bad of altered)
    assert.equal(hasOnlyWalletGuards(expected, message(bad)), false);
  after.signatures[0][0] ^= 1;
  assert.throws(
    () =>
      validateWalletWire(
        expected,
        Buffer.from(after.serialize()).toString("base64"),
        payer.publicKey.toBase58(),
        true,
      ),
    /signature/,
  );
});
