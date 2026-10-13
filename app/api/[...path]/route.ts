import { NextRequest, NextResponse } from "next/server";
import { handle, sameOrigin, wallet, fail, json, hash, rate } from "@/lib/http";
import { challenge, verify } from "@/lib/auth";
import { metadata } from "@/lib/pinata";
import {
  prepareLaunch,
  prepareClaim,
  submit,
  ipPosition,
} from "@/lib/attempts";
import { projectActivity } from "@/lib/activity";
import { dropValue } from "@/lib/value";
import { db } from "@/lib/db";
import { coinCatalog } from "@/lib/catalog";
import { parseSol } from "@/lib/domain";
import { quoteLaunch, rpc, lookupAddresses } from "@/lib/chain";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const path = (await params).path.join("/");
  if (path === "auth/verify") {
    try {
      sameOrigin(req);
      return await verify(req);
    } catch (e) {
      return handle(async () => {
        throw e;
      });
    }
  }
  return handle(async () => {
    sameOrigin(req);
    if (path === "auth/challenge") return challenge(req);
    if (path === "auth/logout") {
      const token = req.cookies.get("artemi_session")?.value;
      if (token)
        await db().query("DELETE FROM artemi_sessions WHERE token_hash=$1", [
          hash(token),
        ]);
      return { ok: true };
    }
    const address = await wallet(req);
    if (path === "metadata") return metadata(req, address);
    if (path === "launch/prepare") return prepareLaunch(req, address);
    if (path === "claim/prepare") return prepareClaim(req, address);
    if (path === "transactions/submit") return submit(req, address);
    if (path === "launch/quote") {
      await rate(`quote:${address}`, 20);
      const data = await json(req);
      let principal: bigint;
      try {
        principal = parseSol(data.sol);
      } catch (e) {
        fail((e as Error).message);
      }
      const q = await quoteLaunch(principal);
      const version = data.version === 1 ? 1 : 0;
      const setup =
        version === 0 &&
        !(
          await db().query("SELECT 1 FROM artemi_lookups WHERE wallet=$1", [
            address,
          ])
        ).rowCount;
      const setupRent = setup
        ? await rpc().getMinimumBalanceForRentExemption(
            56 + 32 * lookupAddresses().length,
          )
        : 0;
      return {
        principal: principal.toString(),
        treasuryTokens: q.reward.toString(),
        creatorTokens: (q.amount - q.reward).toString(),
        bags: q.bags.count,
        remainder: q.bags.remainder.toString(),
        protocolFees: (q.cost - principal).toString(),
        purchaseCost: q.cost.toString(),
        setupRequired: setup,
        setupRent: String(setupRent),
        transactionVersion: version,
        approvals: setup ? 2 : 1,
        networkEstimate: "25000",
        accountRentEstimate: "20000000",
        totalEstimate: (q.cost + BigInt(setupRent) + 20025000n).toString(),
      };
    }
    fail("Not found.", 404);
  });
}
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const path = (await params).path.join("/");
  return handle(async () => {
    if (path === "health") {
      await db().query("SELECT 1");
      const w = (
        await db().query(
          "SELECT heartbeat_at,status FROM artemi_worker_health WHERE id=1",
        )
      ).rows[0];
      return {
        database: true,
        worker:
          !!w &&
          w.status === "ready" &&
          Date.now() - new Date(w.heartbeat_at).getTime() < 90000,
      };
    }
    if (path === "location") return { position: ipPosition(req) };
    if (path === "auth/session") {
      try {
        return { wallet: await wallet(req) };
      } catch {
        return { wallet: null };
      }
    }
    if (path === "coins") {
      const page = Number(req.nextUrl.searchParams.get("page") || 1);
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger((page - 1) * 24)
      )
        fail("Invalid page.");
      return coinCatalog(db(), {
        query: req.nextUrl.searchParams.get("q") || "",
        oldest: req.nextUrl.searchParams.get("sort") === "oldest",
        page,
      });
    }
    if (path.startsWith("value/")) return dropValue(path.split("/")[1]);
    if (path === "activity") {
      const page = Number(req.nextUrl.searchParams.get("page") || 1);
      if (
        !Number.isSafeInteger(page) ||
        page < 1 ||
        !Number.isSafeInteger((page - 1) * 24)
      )
        fail("Invalid page.");
      return projectActivity(
        db(),
        page,
        req.nextUrl.searchParams.get("kind") || "all",
        req.nextUrl.searchParams.get("preview") === "1" ? 5 : 24,
      );
    }
    if (path === "map") {
      const mint = req.nextUrl.searchParams.get("mint");
      const r = await db().query(
        `SELECT b.id,b.mint,b.status,b.amount,c.name,c.ticker,c.image,l.name AS place,l.region,l.lat,l.lng FROM artemi_bags b JOIN artemi_coins c ON c.mint=b.mint JOIN artemi_locations l ON l.id=b.location_id WHERE c.archived_at IS NULL AND b.status!='withdrawn' AND ($1::text IS NULL OR b.mint=$1) ORDER BY b.created_at DESC`,
        [mint],
      );
      const coins = await db().query(
        `SELECT c.*,count(b.id)::int AS total,count(b.id) FILTER(WHERE b.status='available')::int AS available,count(b.id) FILTER(WHERE b.status='claimed')::int AS claimed FROM artemi_coins c LEFT JOIN artemi_bags b ON b.mint=c.mint WHERE c.archived_at IS NULL GROUP BY c.mint ORDER BY c.created_at DESC`,
      );
      const control = (
        await db().query("SELECT paused FROM artemi_controls WHERE id=1")
      ).rows[0];
      return { bags: r.rows, coins: coins.rows, paused: !!control?.paused };
    }
    if (path === "wallet/activity") {
      const address = await wallet(req);
      return {
        attempts: (
          await db().query(
            "SELECT id,kind,mint,bag_id,status,signature,error,created_at FROM artemi_attempts a WHERE wallet=$1 AND a.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM artemi_coins c WHERE c.mint=a.mint AND c.archived_at IS NOT NULL) ORDER BY created_at DESC LIMIT 100",
            [address],
          )
        ).rows,
        coins: (
          await db().query(
            "SELECT mint,name,ticker,image,created_at FROM artemi_coins WHERE creator=$1 AND archived_at IS NULL ORDER BY created_at DESC",
            [address],
          )
        ).rows,
      };
    }
    if (path.startsWith("transactions/")) {
      const address = await wallet(req);
      const id = path.split("/")[1];
      const r = await db().query(
        "SELECT id,kind,mint,status,signature,error FROM artemi_attempts a WHERE id=$1 AND wallet=$2 AND a.archived_at IS NULL AND NOT EXISTS(SELECT 1 FROM artemi_coins c WHERE c.mint=a.mint AND c.archived_at IS NOT NULL)",
        [id, address],
      );
      if (!r.rowCount) fail("Transaction not found.", 404);
      return r.rows[0];
    }
    fail("Not found.", 404);
  });
}
