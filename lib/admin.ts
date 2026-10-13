import { randomBytes, randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { z } from "zod";
import { db, transaction } from "./db";
import { fail, hash, json, rate } from "./http";
import { rpc, treasury } from "./chain";
import { validAdminPassword } from "./admin-password";
const cookie = "artemi_admin";
function passwordTag() {
  const encoded = process.env.ARTEMI_ADMIN_PASSWORD_HASH;
  if (!encoded) fail("Admin access is not configured.", 503);
  return hash(encoded);
}
export async function adminSession(req: NextRequest) {
  const token = req.cookies.get(cookie)?.value;
  if (!token) fail("Sign in to continue.", 401);
  const r = await db().query(
    "SELECT 1 FROM artemi_admin_sessions WHERE token_hash=$1 AND password_tag=$2 AND expires_at>now()",
    [hash(token), passwordTag()],
  );
  if (!r.rowCount) fail("Your admin session expired.", 401);
  return hash(token);
}
export async function adminLogin(req: NextRequest) {
  const ip = process.env.VERCEL
    ? req.headers.get("x-vercel-forwarded-for") ||
      req.headers.get("x-forwarded-for") ||
      "unknown"
    : "local";
  await rate(`admin-login:${hash(ip)}`, 5, 900);
  await rate("admin-login-global", 100, 900);
  const { password } = z
    .object({ password: z.string().max(200) })
    .parse(await json(req));
  passwordTag();
  if (!validAdminPassword(password, process.env.ARTEMI_ADMIN_PASSWORD_HASH!))
    fail("Incorrect password.", 401);
  const token = randomBytes(32).toString("hex");
  await db().query(
    "INSERT INTO artemi_admin_sessions(token_hash,password_tag,expires_at) VALUES($1,$2,now()+interval '4 hours')",
    [hash(token), passwordTag()],
  );
  const res = NextResponse.json(
    { ok: true },
    { headers: { "Cache-Control": "no-store" } },
  );
  res.cookies.set(cookie, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 14400,
  });
  return res;
}
export async function adminLogout(req: NextRequest) {
  const token = req.cookies.get(cookie)?.value;
  if (token)
    await db().query("DELETE FROM artemi_admin_sessions WHERE token_hash=$1", [
      hash(token),
    ]);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(cookie, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/",
    maxAge: 0,
  });
  return res;
}
export function withdrawalDestination(value: string) {
  let key: PublicKey;
  try {
    key = new PublicKey(value);
  } catch {
    fail("Enter a valid Solana wallet address.");
  }
  if (!PublicKey.isOnCurve(key.toBytes()))
    fail("Choose a standard wallet address, not a program account.");
  if (key.equals(treasury()))
    fail("The destination must differ from the treasury.");
  return key.toBase58();
}
export async function queueWithdrawal(
  c: Pick<PoolClient, "query">,
  destination: string,
) {
  const control = (
    await c.query("SELECT * FROM artemi_controls WHERE id=1 FOR UPDATE")
  ).rows[0];
  const active = (
    await c.query(
      "SELECT id FROM artemi_withdrawals WHERE status IN ('waiting','running')",
    )
  ).rows[0];
  if (active) fail("An emergency withdrawal is already in progress.", 409);
  if (!(await c.query("SELECT 1 FROM artemi_coins LIMIT 1")).rowCount)
    fail("There are no launched coin treasuries to withdraw.", 409);
  if (!control) fail("Treasury controls are unavailable.", 503);
  const id = randomUUID();
  await c.query(
    "INSERT INTO artemi_withdrawals(id,destination,status) VALUES($1,$2,'waiting')",
    [id, destination],
  );
  await c.query(
    "UPDATE artemi_controls SET paused=true,withdrawal_id=$1 WHERE id=1",
    [id],
  );
  return { id };
}
export async function requestWithdrawal(req: NextRequest) {
  const session = await adminSession(req);
  await rate(`admin-withdraw:${session}`, 3, 60);
  const data = z
    .object({
      destination: z.string(),
      confirmation: z.literal("WITHDRAW ALL"),
    })
    .parse(await json(req));
  const destination = withdrawalDestination(data.destination);
  return transaction((c) => queueWithdrawal(c, destination));
}
export async function resumeMarket(req: NextRequest) {
  await adminSession(req);
  return transaction(async (c) => {
    await c.query("SELECT id FROM artemi_controls WHERE id=1 FOR UPDATE");
    if (
      (
        await c.query(
          "SELECT 1 FROM artemi_withdrawals WHERE status IN ('waiting','running')",
        )
      ).rowCount
    )
      fail("Wait for the withdrawal to finish before resuming.", 409);
    await c.query("UPDATE artemi_controls SET paused=false WHERE id=1");
    return { ok: true };
  });
}
export async function adminSnapshot(req: NextRequest) {
  await adminSession(req);
  const [control, counts, batches, items, balance] = await Promise.all([
    db().query("SELECT * FROM artemi_controls WHERE id=1"),
    db().query(
      "SELECT (SELECT count(*)::int FROM artemi_coins WHERE archived_at IS NULL) AS coins,count(*) FILTER(WHERE b.status IN ('available','reserved'))::int AS bags FROM artemi_bags b JOIN artemi_coins c ON c.mint=b.mint WHERE c.archived_at IS NULL",
    ),
    db().query(
      "SELECT w.* FROM artemi_withdrawals w WHERE w.status!='completed' OR EXISTS(SELECT 1 FROM artemi_withdrawal_items i JOIN artemi_coins c ON c.mint=i.mint WHERE i.batch_id=w.id AND c.archived_at IS NULL) ORDER BY created_at DESC LIMIT 10",
    ),
    db().query(
      "SELECT i.*,c.name,c.ticker,a.signature,a.status AS transaction_status FROM artemi_withdrawal_items i JOIN artemi_coins c ON c.mint=i.mint LEFT JOIN artemi_attempts a ON a.id=i.attempt_id WHERE c.archived_at IS NULL AND i.batch_id=(SELECT withdrawal_id FROM artemi_controls WHERE id=1) ORDER BY c.name",
    ),
    rpc()
      .getBalance(treasury(), "confirmed")
      .catch(() => null),
  ]);
  return {
    paused: control.rows[0]?.paused || false,
    ...counts.rows[0],
    batches: batches.rows,
    items: items.rows,
    treasury: treasury().toBase58(),
    solBalance: balance === null ? null : String(balance),
  };
}
