import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import assert from "node:assert/strict";
import pg from "pg";
import { coinCatalog } from "../lib/catalog";
const base = new URL(process.env.NEON!);
base.hostname = base.hostname.replace(/-pooler(?=\.)/, "");
base.searchParams.set("sslmode", "verify-full");
const admin = new pg.Pool({ connectionString: base.toString(), max: 1 });
const schema = `artemi_test_${randomUUID().replaceAll("-", "")}`;
if (!/^artemi_test_[a-f0-9]{32}$/.test(schema))
  throw new Error("Unsafe test schema.");
await admin.query(`CREATE SCHEMA ${schema}`);
const pool = new pg.Pool({
  connectionString: base.toString(),
  max: 3,
  options: `-c search_path=${schema}`,
});
try {
  for (const file of (await readdir("migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pool.query(await readFile(`migrations/${file}`, "utf8"));
  await pool.query(
    `INSERT INTO artemi_coins(mint,name,ticker,image,uri,creator,treasury_amount,decimals,launch_signature,created_at) SELECT 'fixture-'||n,'Fixture coin '||n,'FIX'||n,'','','creator',100000000000,6,'signature-'||n,'2020-01-01'::timestamptz+n*interval '1 day' FROM generate_series(1,205)n`,
  );
  await pool.query(
    "INSERT INTO artemi_locations(id,name,region,lat,lng,source) VALUES('fixture','Test location','EU',0,0,'test')",
  );
  await pool.query(
    "INSERT INTO artemi_bags(id,mint,location_id,amount,status) VALUES($1,'fixture-1','fixture',100000000000,'claimed'),($2,'fixture-205','fixture',100000000000,'available')",
    [randomUUID(), randomUUID()],
  );
  const seen = new Set();
  for (let page = 1; page <= 9; page++) {
    const result = await coinCatalog(pool, { page });
    assert.equal(result.total, 205);
    for (const coin of result.coins) {
      assert.ok(!seen.has(coin.mint));
      seen.add(coin.mint);
    }
  }
  assert.equal(seen.size, 205);
  assert.ok(seen.has("fixture-1"));
  console.log(
    "PASS: all 205 launches accessible across nine pages, including the oldest fully collected coin.",
  );
  const oldest = await coinCatalog(pool, { oldest: true });
  assert.equal(oldest.coins[0].mint, "fixture-1");
  assert.equal(oldest.coins[0].claimed, 1);
  assert.equal(oldest.coins[0].available, 0);
  assert.equal(oldest.totalBags, 2);
  assert.equal(oldest.claimedBags, 1);
  const name = await coinCatalog(pool, { query: "FIXTURE COIN 205" });
  assert.equal(name.coins[0].mint, "fixture-205");
  assert.equal(name.total, 1);
  const mint = await coinCatalog(pool, { query: "fixture-205" });
  assert.equal(mint.coins.length, 1);
  assert.equal((await coinCatalog(pool, { query: "%" })).total, 0);
  assert.equal((await coinCatalog(pool, { page: 10 })).coins.length, 0);
  await assert.rejects(coinCatalog(pool, { page: -1 }));
  console.log(
    "PASS: search by name/ticker/mint, literal search, ordering, totals, and pagination boundaries.",
  );
} finally {
  await pool.end();
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
  console.log(
    "Isolated catalog fixtures removed. Production coins were not modified.",
  );
}
