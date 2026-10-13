import { readFileSync } from "node:fs";
if (!process.env.ARTEMI_TREASURY_PRIVATE_KEY) {
  process.env.ARTEMI_TREASURY_PRIVATE_KEY = readFileSync(
    process.env.ARTEMI_TREASURY_KEY_FILE || ".secrets/treasury.json",
    "utf8",
  );
}
await import("../worker/index");
export {};
