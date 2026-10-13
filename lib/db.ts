import pg from "pg";
const globalDb = globalThis as unknown as { artemiPool?: pg.Pool };
export function db() {
  if (!globalDb.artemiPool) {
    const connectionString = process.env.NEON || process.env.DATABASE_URL;
    if (!connectionString) throw new Error("Database is not configured.");
    const secureUrl = new URL(connectionString);
    secureUrl.searchParams.set("sslmode", "verify-full");
    globalDb.artemiPool = new pg.Pool({
      connectionString: secureUrl.toString(),
      max: 5,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 20000,
    });
  }
  return globalDb.artemiPool;
}
export async function transaction<T>(
  fn: (c: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const c = await db().connect();
  try {
    await c.query("BEGIN");
    const result = await fn(c);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}
