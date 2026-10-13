import { randomInt } from "node:crypto";
import land from "./data/land.json";
type Point = { lat: number; lng: number };
type Region = "EU" | "US";
type Polygon = number[][][];
const rad = Math.PI / 180;
const unit = () => randomInt(2 ** 48 - 1) / (2 ** 48 - 1);

function inRing(p: Point, ring: number[][]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i],
      [xj, yj] = ring[j];
    if (
      yi > p.lat !== yj > p.lat &&
      p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}
export function inPolygon(p: Point, polygon: Polygon) {
  return inRing(p, polygon[0]) && !polygon.slice(1).some((r) => inRing(p, r));
}
// Regional envelope excludes overseas European dependencies and Asian Russia.
// Turkey is restricted to eastern Thrace; Cyprus is included with Europe.
// Natural Earth's generalized boundaries are not a public-access guarantee.
const envelopes = (code: string, region: string) =>
  region === "US"
    ? [-180, 18, 180, 72]
    : code === "TUR"
      ? [25, 40, 29.2, 43]
      : [-32, 34, 60, 82];
// Follow the European shore of the Dardanelles, Marmara and Bosphorus.
// Country clipping alone would otherwise include northwestern Anatolia.
const thrace: Polygon = [
  [
    [25, 43],
    [30, 43],
    [29.15, 41.23],
    [29.06, 41.15],
    [29.055, 41.08],
    [29.0, 41.04],
    [28.98, 41.0],
    [28.5, 40.97],
    [27.5, 40.75],
    [27.1, 40.62],
    [26.7, 40.43],
    [26.5, 40.23],
    [26.2, 40.03],
    [25, 40],
    [25, 43],
  ],
];
const allowed = (code: string, p: Point) =>
  code !== "TUR" || inPolygon(p, thrace);
const pieces = land.features
  .flatMap((f) =>
    f.polygons.map((polygon) => {
      const envelope = envelopes(f.code, f.region);
      const xs = polygon[0].map((p) => p[0]),
        ys = polygon[0].map((p) => p[1]);
      const west = Math.max(Math.min(...xs), envelope[0]),
        east = Math.min(Math.max(...xs), envelope[2]);
      const south = Math.max(Math.min(...ys), envelope[1]),
        north = Math.min(Math.max(...ys), envelope[3]);
      const sinSouth = Math.sin(south * rad),
        sinNorth = Math.sin(north * rad);
      return {
        polygon,
        code: f.code,
        name: f.name,
        region: f.region,
        west,
        east,
        sinSouth,
        sinNorth,
        weight:
          east > west && north > south
            ? (east - west) * (sinNorth - sinSouth)
            : 0,
      };
    }),
  )
  .filter((p) => p.weight > 0);

export function coveredLand(region: Region, p: Point) {
  return pieces.some(
    (x) =>
      x.region === region &&
      p.lng >= x.west &&
      p.lng <= x.east &&
      Math.sin(p.lat * rad) >= x.sinSouth &&
      Math.sin(p.lat * rad) <= x.sinNorth &&
      inPolygon(p, x.polygon) &&
      allowed(x.code, p),
  );
}
export function randomLandLocation(region: Region, random = unit) {
  const options = pieces.filter((p) => p.region === region);
  const total = options.reduce((sum, p) => sum + p.weight, 0);
  // Weight bounding rectangles by spherical area; resample the entire mixture
  // on rejection. This avoids favoring cities, small countries or high latitudes.
  for (let attempt = 0; attempt < 10000; attempt++) {
    let target = random() * total;
    const piece =
      options.find((p) => (target -= p.weight) < 0) ?? options.at(-1)!;
    const p = {
      lng: piece.west + random() * (piece.east - piece.west),
      lat:
        Math.asin(
          piece.sinSouth + random() * (piece.sinNorth - piece.sinSouth),
        ) / rad,
    };
    if (inPolygon(p, piece.polygon) && allowed(piece.code, p))
      return {
        ...p,
        region,
        name: `${piece.name} · ${p.lat.toFixed(4)}, ${p.lng.toFixed(4)}`,
        source: land.source,
        version: land.version,
      };
  }
  throw new Error("Land placement could not be sampled.");
}
