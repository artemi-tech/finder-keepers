import { Keypair } from "@solana/web3.js";
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync(".secrets", { recursive: true });
const key = Keypair.generate();
writeFileSync(".secrets/treasury.json", JSON.stringify(Array.from(key.secretKey)), {
  mode: 0o600,
  flag: "wx",
});
console.log("Treasury public key:", key.publicKey.toBase58());
console.log("Private key saved to .secrets/treasury.json; keep it private and backed up.");
