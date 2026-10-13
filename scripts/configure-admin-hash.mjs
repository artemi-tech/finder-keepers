import { randomBytes, scryptSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const password = process.env.ARTEMI_ADMIN_PASSWORD;
if (!password || password.length < 12 || password.length > 200)
  throw new Error("Provide ARTEMI_ADMIN_PASSWORD with 12–200 characters in the process environment.");
const salt = randomBytes(16).toString("hex");
const encoded = `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
const original = readFileSync(".env", "utf8");
const line = `ARTEMI_ADMIN_PASSWORD_HASH=${encoded}`;
const updated = /^ARTEMI_ADMIN_PASSWORD_HASH=.*$/m.test(original)
  ? original.replace(/^ARTEMI_ADMIN_PASSWORD_HASH=.*$/m, line)
  : `${original}\n${line}\n`;
writeFileSync(".env", updated, { mode: 0o600 });
console.log("Operator password hash saved to ignored .env. No credential values printed.");
