import { readFile, readdir } from "node:fs/promises";
import { db, transaction } from "../lib/db";
await db().query(
  "CREATE TABLE IF NOT EXISTS artemi_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
);
for (const file of (await readdir("migrations"))
  .filter((x) => x.endsWith(".sql"))
  .sort()) {
  if (
    (await db().query("SELECT 1 FROM artemi_migrations WHERE name=$1", [file]))
      .rowCount
  )
    continue;
  await transaction(async (c) => {
    await c.query(await readFile(`migrations/${file}`, "utf8"));
    await c.query("INSERT INTO artemi_migrations(name) VALUES($1)", [file]);
  });
  console.log("Applied", file);
}
console.log("Application migrations ready; new locations are sampled when launches finalize.");
await db().end();
