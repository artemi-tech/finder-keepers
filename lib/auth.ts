import { NextRequest, NextResponse } from "next/server";
import { randomBytes, randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import nacl from "tweetnacl";
import { db, transaction } from "./db";
import { fail, hash, json, rate } from "./http";
import { publicKey } from "./validation";
export async function challenge(req: NextRequest) {
  const data = await json(req);
  const address = publicKey.parse(data.wallet);
  new PublicKey(address);
  await rate(`auth:${address}`, 10);
  const id = randomUUID();
  const message = `${req.nextUrl.host} wants you to sign in to Artemi.\n\nWallet: ${address}\nNonce: ${id}\nIssued: ${new Date().toISOString()}\n\nThis signature verifies your wallet. It does not authorize a transaction.`;
  await db().query(
    "INSERT INTO artemi_nonces(id,wallet,message,expires_at) VALUES($1,$2,$3,now()+interval '5 minutes')",
    [id, address, message],
  );
  return { id, message };
}
export async function verify(req: NextRequest) {
  const data = await json(req);
  if (typeof data.id !== "string" || typeof data.signature !== "string")
    fail("Invalid signature.");
  const token = randomBytes(32).toString("hex");
  const address = await transaction(async (c) => {
    const r = await c.query(
      "DELETE FROM artemi_nonces WHERE id=$1 AND expires_at>now() RETURNING *",
      [data.id],
    );
    if (!r.rowCount) fail("The sign-in request expired.");
    const n = r.rows[0];
    const sig = Buffer.from(data.signature, "base64");
    if (
      sig.length !== 64 ||
      !nacl.sign.detached.verify(
        Buffer.from(n.message),
        sig,
        new PublicKey(n.wallet).toBytes(),
      )
    )
      fail("The wallet signature is invalid.", 401);
    await c.query(
      "INSERT INTO artemi_sessions(token_hash,wallet,expires_at) VALUES($1,$2,now()+interval '24 hours')",
      [hash(token), n.wallet],
    );
    return n.wallet;
  });
  const res = NextResponse.json({ wallet: address });
  res.cookies.set("artemi_session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 86400,
  });
  return res;
}
