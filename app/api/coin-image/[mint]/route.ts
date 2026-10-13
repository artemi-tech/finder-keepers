import { serveCoinImage } from "@/lib/coin-image";
export const runtime = "nodejs";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ mint: string }> },
) {
  return serveCoinImage((await params).mint);
}
