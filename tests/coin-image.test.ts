import test from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { serveCoinImage } from "../lib/coin-image";
test("coin images use the configured gateway, cache valid images and reject arbitrary URLs or non-images", async () => {
  const mint = "AHHF466U2P8Q9mcAcZvX11UWRvSNkzhe6bursFxupiu4",
    cid = "bafybeifugt63k5gvpo7p7scwlqenhbrh6qekh63yxd2iynzom6cjupcjy4";
  let image = `https://ipfs.io/ipfs/${cid}`,
    calls = 0;
  const originalFetch = globalThis.fetch,
    originalGateway = process.env.PINATA_GATEWAY;
  (globalThis as unknown as { artemiPool: Pool }).artemiPool = {
    query: async () => ({ rows: [{ image }] }),
  } as unknown as Pool;
  process.env.PINATA_GATEWAY = "test-gateway.mypinata.cloud";
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(
      String(url),
      `https://test-gateway.mypinata.cloud/ipfs/${cid}`,
    );
    assert.equal(options?.redirect, "error");
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { "Content-Type": "image/png" },
    });
  };
  try {
    const response = await serveCoinImage(mint);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.match(response.headers.get("Cache-Control")!, /s-maxage=86400/);
    assert.equal((await response.arrayBuffer()).byteLength, 4);
    assert.equal((await serveCoinImage("../secret")).status, 404);
    image = "https://127.0.0.1/internal";
    assert.equal((await serveCoinImage(mint)).status, 404);
    assert.equal(calls, 1);
    image = `https://ipfs.io/ipfs/${cid}`;
    globalThis.fetch = async () => new Response("limited", { status: 429 });
    const limited = await serveCoinImage(mint);
    assert.equal(limited.status, 502);
    assert.equal(limited.headers.get("Cache-Control"), "no-store");
    globalThis.fetch = async () =>
      new Response("<script>bad</script>", {
        headers: { "Content-Type": "text/html" },
      });
    assert.equal((await serveCoinImage(mint)).status, 502);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalGateway) process.env.PINATA_GATEWAY = originalGateway;
    else delete process.env.PINATA_GATEWAY;
  }
});
