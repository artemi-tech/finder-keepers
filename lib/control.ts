import type { PoolClient } from "pg";
import { fail } from "./http";
export async function assertMarketOpen(c: Pick<PoolClient, "query">) {
  const r = await c.query(
    "SELECT paused FROM artemi_controls WHERE id=1 FOR SHARE",
  );
  if (!r.rowCount || r.rows[0].paused)
    fail("Launches and claims are paused for treasury maintenance.", 503);
}
