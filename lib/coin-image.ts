import { db } from "./db";
export async function serveCoinImage(mint: string) {
  const unavailable = (status: number) =>
    new Response("Coin image unavailable", {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) return unavailable(404);
  const coin = (
    await db().query(
      "SELECT image FROM artemi_coins WHERE mint=$1 AND archived_at IS NULL",
      [mint],
    )
  ).rows[0];
  const cid = coin?.image?.match(
    /^https:\/\/ipfs\.io\/ipfs\/([a-zA-Z0-9]+)$/,
  )?.[1];
  if (!cid) return unavailable(404);
  const gateway = process.env.PINATA_GATEWAY;
  if (!gateway) return unavailable(503);
  try {
    const url = new URL(
      `/ipfs/${cid}`,
      gateway.startsWith("https://") ? gateway : `https://${gateway}`,
    );
    if (url.protocol !== "https:" || url.username || url.password)
      return unavailable(503);
    const response = await fetch(url, {
      redirect: "error",
      signal: AbortSignal.timeout(12000),
      next: { revalidate: 86400 },
    });
    const type = response.headers.get("content-type")?.split(";")[0];
    if (
      !response.ok ||
      !type ||
      !["image/png", "image/jpeg", "image/webp"].includes(type) ||
      Number(response.headers.get("content-length")) > 3_000_000
    )
      return unavailable(502);
    const reader = response.body?.getReader();
    if (!reader) return unavailable(502);
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 3_000_000) {
        await reader.cancel();
        return unavailable(502);
      }
      chunks.push(value);
    }
    return new Response(Buffer.concat(chunks), {
      headers: {
        "Content-Type": type,
        "Cache-Control":
          "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return unavailable(502);
  }
}
