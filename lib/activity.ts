import type { Pool } from "pg";
export async function projectActivity(
  pool: Pick<Pool, "query">,
  page = 1,
  kind = "all",
  pageSize = 24,
) {
  if (
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger((page - 1) * pageSize)
  )
    throw new Error("Invalid page.");
  const type = ["launch", "claim", "withdrawal"].includes(kind) ? kind : "all";
  const where =
    "c.archived_at IS NULL AND a.status='finalized' AND a.kind IN ('launch','claim','withdrawal') AND ($1='all' OR a.kind=$1)";
  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT a.id,a.kind,a.wallet,a.mint,a.signature,a.updated_at AS created_at,coalesce(a.payload->>'amount',a.payload->>'total','0') AS amount,a.payload->>'principal' AS principal,c.name,c.ticker,c.image,c.decimals,l.name AS place FROM artemi_attempts a JOIN artemi_coins c ON c.mint=a.mint LEFT JOIN artemi_bags b ON b.id=a.bag_id LEFT JOIN artemi_locations l ON l.id=b.location_id WHERE ${where} ORDER BY a.updated_at DESC,a.id DESC LIMIT $2 OFFSET $3`,
      [type, pageSize, (page - 1) * pageSize],
    ),
    pool.query(
      `SELECT count(*)::int AS total FROM artemi_attempts a JOIN artemi_coins c ON c.mint=a.mint WHERE ${where}`,
      [type],
    ),
  ]);
  return { events: rows.rows, total: count.rows[0].total, page, pageSize };
}
