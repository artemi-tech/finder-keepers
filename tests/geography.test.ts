import test from "node:test";
import assert from "node:assert/strict";
import { coveredLand, inPolygon, randomLandLocation } from "../lib/geography";
test("land coverage includes rural USA, Alaska, Hawaii, and European countryside, excluding oceans and overseas land", () => {
  for (const [region, lat, lng] of [
    ["US", 39, -100],
    ["US", 64, -150],
    ["US", 19.6, -155.5],
    ["EU", 47, 2],
    ["EU", 65, 26],
    ["EU", 56, 40],
    ["EU", 65, -18],
    ["EU", 41.5, 27],
  ] as const)
    assert.ok(coveredLand(region, { lat, lng }), `${region} ${lat},${lng}`);
  for (const [region, lat, lng] of [
    ["US", 40, -30],
    ["EU", 0, 0],
    ["EU", 55, 100],
    ["EU", 4, -53],
    ["EU", 40.2, 29.05],
  ] as const)
    assert.equal(coveredLand(region, { lat, lng }), false);
  assert.equal(
    inPolygon({ lat: 5, lng: 5 }, [
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
        [0, 0],
      ],
      [
        [4, 4],
        [6, 4],
        [6, 6],
        [4, 6],
        [4, 4],
      ],
    ]),
    false,
    "Polygon holes are excluded",
  );
});
test("area-weighted placement covers both regions broadly without city reuse", () => {
  let state = 23456789;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (const region of ["EU", "US"] as const) {
    const points = Array.from({ length: 1000 }, () =>
      randomLandLocation(region, random),
    );
    assert.ok(points.every((p) => coveredLand(region, p)));
    assert.equal(new Set(points.map((p) => `${p.lat},${p.lng}`)).size, 1000);
    assert.ok(
      Math.max(...points.map((p) => p.lng)) -
        Math.min(...points.map((p) => p.lng)) >
        50,
    );
    assert.ok(
      Math.max(...points.map((p) => p.lat)) -
        Math.min(...points.map((p) => p.lat)) >
        25,
    );
    assert.ok(points.every((p) => p.version === 2));
  }
});
