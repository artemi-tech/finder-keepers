import { NextRequest, NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { db } from "./db";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
export function fail(message: string, status = 400): never {
  throw new HttpError(status, message);
}
export function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
export async function wallet(req: NextRequest) {
  const token = req.cookies.get("artemi_session")?.value;
  if (!token) fail("Connect and verify your wallet first.", 401);
  const r = await db().query(
    "SELECT wallet FROM artemi_sessions WHERE token_hash=$1 AND expires_at>now()",
    [hash(token)],
  );
  if (!r.rowCount) fail("Your session expired. Reconnect your wallet.", 401);
  return r.rows[0].wallet as string;
}
export async function rate(
  key: string,
  max = 30,
  seconds = 60,
  client: Pick<ReturnType<typeof db>, "query"> = db(),
) {
  const r = await client.query(
    `INSERT INTO artemi_rates(key,hits,resets_at) VALUES($1,1,now()+$2*interval '1 second') ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN artemi_rates.resets_at<now() THEN 1 ELSE artemi_rates.hits+1 END,resets_at=CASE WHEN artemi_rates.resets_at<now() THEN now()+$2*interval '1 second' ELSE artemi_rates.resets_at END RETURNING hits, greatest(1,ceil(extract(epoch FROM resets_at-now())))::int AS retry_after`,
    [key, seconds],
  );
  if (r.rows[0].hits > max) {
    const wait = Number(r.rows[0].retry_after);
    throw new HttpError(
      429,
      `Too many requests. Please try again in ${wait < 60 ? `${wait} seconds` : `${Math.ceil(wait / 60)} minutes`}.`,
      wait,
    );
  }
}
export function sameOrigin(req: NextRequest) {
  const origin = req.headers.get("origin");
  if (!origin || origin !== req.nextUrl.origin)
    fail("Invalid request origin.", 403);
}
export async function json(req: NextRequest) {
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 20000) fail("Request too large.", 413);
  const raw = await req.text();
  if (raw.length > 20000) fail("Request too large.", 413);
  try {
    return JSON.parse(raw);
  } catch {
    fail("Invalid JSON.");
  }
}
export async function handle(fn: () => Promise<unknown>) {
  try {
    const result = await fn();
    if (result instanceof NextResponse) return result;
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (e) {
    if (e instanceof HttpError)
      return NextResponse.json(
        {
          error: e.message,
          ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}),
        },
        {
          status: e.status,
          headers: e.retryAfter
            ? { "Retry-After": String(e.retryAfter) }
            : undefined,
        },
      );
    if (e instanceof Error && e.name === "ZodError")
      return NextResponse.json(
        { error: "Check the form fields and try again." },
        { status: 400 },
      );
    console.error("request_failed", e instanceof Error ? e.name : "unknown");
    return NextResponse.json(
      { error: "This action is temporarily unavailable. Please retry." },
      { status: 503 },
    );
  }
}
