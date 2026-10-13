import { VersionedMessage, TransactionMessage } from "@solana/web3.js";
import { db } from "../lib/db";
const wallet = process.argv[2];
if (!wallet) throw new Error("Pass the public wallet address to inspect.");
const p = db();
try {
  const attempts = (
    await p.query(
      "SELECT id,kind,status,message,payload->'walletDiagnostic' AS diagnostic FROM artemi_attempts WHERE wallet=$1 AND payload ? 'walletDiagnostic' ORDER BY created_at DESC LIMIT 3",
      [wallet],
    )
  ).rows;
  for (const a of attempts) {
    const expected = VersionedMessage.deserialize(
      Buffer.from(a.message, "base64"),
    );
    const received = VersionedMessage.deserialize(
      Buffer.from(a.diagnostic.receivedMessage, "base64"),
    );
    const describe = (m: typeof expected) => ({
      version: m.version,
      blockhash: m.recentBlockhash,
      keys: m.staticAccountKeys.map((k) => k.toBase58()),
      instructions: TransactionMessage.decompile(m).instructions.map((i) => ({
        program: i.programId.toBase58(),
        keys: i.keys.map((k) => ({
          address: k.pubkey.toBase58(),
          signer: k.isSigner,
          writable: k.isWritable,
        })),
        data: i.data.toString("hex"),
      })),
    });
    const before = describe(expected),
      after = describe(received);
    console.log(
      JSON.stringify(
        {
          id: a.id,
          kind: a.kind,
          status: a.status,
          at: a.diagnostic.at,
          before,
          after,
        },
        null,
        2,
      ),
    );
  }
  if (!attempts.length) console.log("No captured mismatch yet.");
} finally {
  await p.end();
}
