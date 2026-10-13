import { VersionedMessage, TransactionMessage } from "@solana/web3.js";

// Immutable Lighthouse deployment, and only its single-account read-only
// assertions. MemoryWrite/MemoryClose and other programs are never accepted.
// https://github.com/Jac0xb/lighthouse/blob/main/programs/lighthouse/src/instruction.rs
export const LIGHTHOUSE = "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95";
const READ_ONLY_ASSERTIONS = new Set([2, 3, 5, 6, 7, 8, 9, 10]);
export function hasOnlyWalletGuards(
  expected: string,
  received: string,
): boolean {
  try {
    const before = VersionedMessage.deserialize(
      Buffer.from(expected, "base64"),
    );
    const after = VersionedMessage.deserialize(Buffer.from(received, "base64"));
    if (
      before.version !== 0 ||
      after.version !== 0 ||
      before.addressTableLookups.length ||
      after.addressTableLookups.length ||
      before.recentBlockhash !== after.recentBlockhash ||
      !before.staticAccountKeys[0].equals(after.staticAccountKeys[0])
    )
      return false;
    const roles = (m: typeof before) =>
      new Map(
        m.staticAccountKeys.map((key, i) => [
          key.toBase58(),
          `${m.isAccountSigner(i)}:${m.isAccountWritable(i)}`,
        ]),
      );
    const original = roles(before),
      changed = roles(after);
    for (const [key, role] of original)
      if (changed.get(key) !== role) return false;
    for (const [key, role] of changed)
      if (!original.has(key) && (key !== LIGHTHOUSE || role !== "false:false"))
        return false;
    const a = TransactionMessage.decompile(before),
      b = TransactionMessage.decompile(after);
    let guards = 0;
    const core = b.instructions.filter((i) => {
      if (i.programId.toBase58() !== LIGHTHOUSE) return true;
      if (
        !READ_ONLY_ASSERTIONS.has(i.data[0]) ||
        i.data.length < 3 ||
        i.data.length > 512 ||
        i.keys.length !== 1 ||
        !original.has(i.keys[0].pubkey.toBase58())
      )
        throw new Error("Unexpected guard");
      guards++;
      return false;
    });
    const canonical = (ix: typeof core) =>
      JSON.stringify(
        ix.map((i) => ({
          program: i.programId.toBase58(),
          data: i.data.toString("hex"),
          keys: i.keys.map((k) => ({
            address: k.pubkey.toBase58(),
            signer: k.isSigner,
            writable: k.isWritable,
          })),
        })),
      );
    return (
      guards > 0 && guards <= 8 && canonical(a.instructions) === canonical(core)
    );
  } catch {
    return false;
  }
}
