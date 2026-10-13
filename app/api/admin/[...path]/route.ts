import { NextRequest } from "next/server";
import {
  adminLogin,
  adminLogout,
  adminSnapshot,
  requestWithdrawal,
  resumeMarket,
} from "@/lib/admin";
import { handle, sameOrigin, fail } from "@/lib/http";
export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return handle(async () => {
    sameOrigin(req);
    const path = (await params).path.join("/");
    if (path === "login") return adminLogin(req);
    if (path === "logout") return adminLogout(req);
    if (path === "withdraw") return requestWithdrawal(req);
    if (path === "resume") return resumeMarket(req);
    fail("Not found.", 404);
  });
}
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  return handle(async () => {
    if ((await params).path.join("/") === "status") return adminSnapshot(req);
    fail("Not found.", 404);
  });
}
