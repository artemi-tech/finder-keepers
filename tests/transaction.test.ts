import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
} from "@solana/web3.js";
import { validateSigned } from "../lib/attempts";
import { wireMessage } from "../lib/wire";
function fixture() {
  const user = Keypair.generate(),
    recipient = Keypair.generate().publicKey;
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: user.publicKey,
      recentBlockhash: Keypair.generate().publicKey.toBase58(),
      instructions: [
        SystemProgram.transfer({
          fromPubkey: user.publicKey,
          toPubkey: recipient,
          lamports: 1000,
        }),
      ],
    }).compileToV0Message(),
  );
  tx.sign([user]);
  return {
    user,
    tx,
    message: Buffer.from(tx.message.serialize()).toString("base64"),
  };
}
test("signed transaction must match the exact server-generated message", () => {
  const { user, tx, message } = fixture();
  assert.equal(
    wireMessage(
      validateSigned(
        message,
        Buffer.from(tx.serialize()).toString("base64"),
        user.publicKey.toBase58(),
      ),
    ),
    message,
  );
  tx.message.recentBlockhash = Keypair.generate().publicKey.toBase58();
  tx.sign([user]);
  assert.throws(
    () =>
      validateSigned(
        message,
        Buffer.from(tx.serialize()).toString("base64"),
        user.publicKey.toBase58(),
      ),
    /changed/,
  );
});
test("wrong wallet, corrupted signature and malformed transaction are rejected", () => {
  const { user, tx, message } = fixture();
  assert.throws(
    () =>
      validateSigned(
        message,
        Buffer.from(tx.serialize()).toString("base64"),
        Keypair.generate().publicKey.toBase58(),
      ),
    /signature/,
  );
  tx.signatures[0][0] ^= 1;
  assert.throws(
    () =>
      validateSigned(
        message,
        Buffer.from(tx.serialize()).toString("base64"),
        user.publicKey.toBase58(),
      ),
    /signature/,
  );
  assert.throws(
    () => validateSigned(message, "garbage", user.publicKey.toBase58()),
    /transaction/,
  );
});
