import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { metadataSchema } from "./validation";
import { transaction } from "./db";
import { fail, rate } from "./http";
async function upload(file: File) {
  const body = new FormData();
  body.set("network", "public");
  body.set("file", file);
  const r = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.PINATA_JWT}` },
    body,
    signal: AbortSignal.timeout(25000),
  });
  if (!r.ok) fail("Image storage is temporarily unavailable.", 503);
  const j = await r.json();
  if (!/^[a-zA-Z0-9]+$/.test(j.data?.cid || ""))
    fail("Storage returned an invalid identifier.", 503);
  return `https://ipfs.io/ipfs/${j.data.cid}`;
}
export async function metadata(req: NextRequest, address: string) {
  await rate(`upload-request:${address}`, 30, 60);
  if (Number(req.headers.get("content-length") || 0) > 3_500_000)
    fail("Choose an image smaller than 3 MB.", 413);
  const form = await req.formData();
  const data = metadataSchema.parse(
    Object.fromEntries(
      ["name", "ticker", "twitter", "website"].map((k) => [
        k,
        form.get(k) || "",
      ]),
    ),
  );
  const file = form.get("image");
  if (
    !(file instanceof File) ||
    file.size > 3_000_000 ||
    !["image/png", "image/jpeg", "image/webp"].includes(file.type)
  )
    fail("Use a PNG, JPEG, or WebP image smaller than 3 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const valid =
    (file.type === "image/png" &&
      bytes[0] === 137 &&
      bytes[1] === 80 &&
      bytes[2] === 78 &&
      bytes[3] === 71) ||
    (file.type === "image/jpeg" &&
      bytes[0] === 255 &&
      bytes[1] === 216 &&
      bytes[2] === 255) ||
    (file.type === "image/webp" &&
      Buffer.from(bytes.slice(0, 4)).toString() === "RIFF" &&
      Buffer.from(bytes.slice(8, 12)).toString() === "WEBP");
  if (!valid) fail("The image format does not match its contents.");
  const id = metadataId(address, data, file.type, bytes);
  return transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [id]);
    const existing = (
      await c.query(
        "SELECT id,image,uri FROM artemi_uploads WHERE id=$1 AND wallet=$2",
        [id, address],
      )
    ).rows[0];
    if (existing) return existing;
    // Only a new, valid set of metadata consumes the storage quota.
    await rate(`upload:${address}`, 5, 3600, c);
    const image = await upload(file);
    const uri = await upload(
      new File(
        [
          JSON.stringify({
            name: data.name,
            symbol: data.ticker,
            description: `Discover ${data.name} through Artemi.`,
            image,
            showName: true,
            createdOn: req.nextUrl.origin,
            twitter: data.twitter,
            website: data.website,
          }),
        ],
        "metadata.json",
        { type: "application/json" },
      ),
    );
    await c.query(
      "INSERT INTO artemi_uploads(id,wallet,name,ticker,image,uri,twitter,website) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [
        id,
        address,
        data.name,
        data.ticker,
        image,
        uri,
        data.twitter,
        data.website,
      ],
    );
    return { id, image, uri };
  });
}
export function metadataId(
  wallet: string,
  data: { name: string; ticker: string; twitter?: string; website?: string },
  type: string,
  bytes: Uint8Array,
) {
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        wallet,
        data.name,
        data.ticker,
        data.twitter || "",
        data.website || "",
        type,
      ]),
    )
    .update(bytes)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
