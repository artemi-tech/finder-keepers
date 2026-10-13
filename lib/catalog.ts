import type { Pool } from "pg";
export async function coinCatalog(
  pool: Pick<Pool, "query">,
  {
    query = "",
    oldest = false,
    page = 1,
  }: { query?: string; oldest?: boolean; page?: number },
) {
  const pageSize = 24,
    offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(offset))
    throw new Error("Invalid page.");
  const q = query.trim().slice(0, 128),
    sort = oldest ? "ASC" : "DESC";
  const match = `c.archived_at IS NULL AND ($1::text='' OR strpos(lower(c.name||' '||c.ticker||' '||c.mint),lower($1))>0)`;
  const [items, counts] = await Promise.all([
    pool.query(
      `SELECT c.*,count(b.id)::int AS total,count(b.id) FILTER(WHERE b.status='available')::int AS available,count(b.id) FILTER(WHERE b.status='claimed')::int AS claimed,count(b.id) FILTER(WHERE b.status='withdrawn')::int AS withdrawn FROM artemi_coins c LEFT JOIN artemi_bags b ON b.mint=c.mint WHERE ${match} GROUP BY c.mint ORDER BY c.created_at ${sort},c.mint ${sort} LIMIT $2 OFFSET $3`,
      [q, pageSize, offset],
    ),
    pool.query(
      `SELECT (SELECT count(*)::int FROM artemi_coins c WHERE ${match}) AS total,(SELECT count(*)::int FROM artemi_coins WHERE archived_at IS NULL) AS "totalCoins",count(*)::int AS "totalBags",count(*) FILTER(WHERE b.status='claimed')::int AS "claimedBags" FROM artemi_bags b JOIN artemi_coins c ON c.mint=b.mint WHERE c.archived_at IS NULL`,
      [q],
    ),
  ]);
  return { coins: items.rows, ...counts.rows[0], page, pageSize };
}
