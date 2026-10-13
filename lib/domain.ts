export const LAMPORTS = 1_000_000_000n;
export const TREASURY_PRINCIPAL = 200_000_000n;
export const BAG_TOKENS = 300_000n;
export const CLAIM_RADIUS = 10_000;
export type Position = {
  lat: number;
  lng: number;
  source: "browser" | "ip";
  timestamp: number;
};
export type Bag = {
  id: string;
  mint: string;
  name: string;
  ticker: string;
  image: string;
  lat: number;
  lng: number;
  place: string;
  region: "EU" | "US";
  status: "available" | "reserved" | "claimed" | "withdrawn";
  amount: string;
};
export type Coin = {
  mint: string;
  name: string;
  ticker: string;
  image: string;
  creator: string;
  twitter: string;
  website: string;
  treasury_amount: string;
  decimals: number;
  launch_signature: string;
  created_at: string;
  available: number;
  total: number;
  claimed: number;
  withdrawn?: number;
  withdrawn_amount?: string;
  rewards_withdrawn?: boolean;
  bag_tokens?: string;
};
export function reservedRewards(coin: Coin): bigint {
  if (coin.rewards_withdrawn) return 0n;
  const remaining =
    BigInt(coin.treasury_amount) -
    BigInt(coin.claimed) *
      BigInt(coin.bag_tokens ?? BAG_TOKENS) *
      10n ** BigInt(coin.decimals) -
    BigInt(coin.withdrawn_amount || 0);
  return remaining > 0n ? remaining : 0n;
}
export function parseSol(value: string): bigint {
  if (!/^\d{1,6}(\.\d{1,9})?$/.test(value))
    throw new Error("Enter a SOL amount with at most 9 decimal places.");
  const [whole, fraction = ""] = value.split(".");
  const n = BigInt(whole) * LAMPORTS + BigInt(fraction.padEnd(9, "0"));
  if (n < TREASURY_PRINCIPAL)
    throw new Error("The minimum developer purchase is 0.2 SOL.");
  return n;
}
export function principalTokens(
  principal: bigint,
  virtualSol: bigint,
  virtualTokens: bigint,
  realTokens: bigint,
) {
  const n = (principal * virtualTokens) / (virtualSol + principal);
  if (n > realTokens)
    throw new Error("Purchase exceeds the initial bonding curve capacity.");
  return n;
}
export function partition(
  amount: bigint,
  decimals: number,
  bagTokens = BAG_TOKENS,
) {
  if (bagTokens <= 0n) throw new Error("Bag size must be positive.");
  const size = bagTokens * 10n ** BigInt(decimals);
  return { size, count: Number(amount / size), remainder: amount % size };
}
export function distanceMetres(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const rad = (n: number) => (n * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat),
    dLng = rad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return (
    6371008.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)))
  );
}
export function validCoordinates(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}
export function eligible(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  return (
    validCoordinates(a.lat, a.lng) &&
    validCoordinates(b.lat, b.lng) &&
    distanceMetres(a, b) <= CLAIM_RADIUS
  );
}
export function regionalCounts(count: number, oddToEurope: boolean) {
  const half = Math.floor(count / 2);
  return {
    EU: half + (count % 2 && oddToEurope ? 1 : 0),
    US: half + (count % 2 && !oddToEurope ? 1 : 0),
  };
}
