import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSol,
  principalTokens,
  partition,
  regionalCounts,
  distanceMetres,
  eligible,
  validCoordinates,
  TREASURY_PRINCIPAL,
  BAG_TOKENS,
} from "../lib/domain";
test("purchase amounts preserve lamports and reject unsafe input", () => {
  assert.equal(parseSol("0.2"), 200000000n);
  assert.equal(parseSol("0.200000001"), 200000001n);
  assert.equal(parseSol("2"), 2000000000n);
  for (const value of ["0.199999999", "-1", "NaN", "1e3", "1.1234567890"])
    assert.throws(() => parseSol(value));
});
test("first 0.2 SOL allocation funds 23 bags independently of the total purchase", () => {
  const quote = (p: bigint) =>
    principalTokens(p, 30000000000n, 1073000000000000n, 793100000000000n);
  assert.equal(TREASURY_PRINCIPAL, 200000000n);
  assert.equal(BAG_TOKENS, 300000n);
  const treasury = quote(TREASURY_PRINCIPAL);
  assert.equal(treasury, 7105960264900n);
  assert.ok(quote(2000000000n) > treasury);
  const p = partition(treasury, 6);
  assert.equal(p.count, 23);
  assert.equal(p.size, 300000000000n);
  assert.equal(p.remainder, 205960264900n);
  assert.equal(BigInt(p.count) * p.size + p.remainder, treasury);
  assert.ok(p.remainder < p.size);
});
test("bags never allocate tokens beyond the treasury balance", () => {
  for (const n of [0n, 299999999999n, 300000000000n, 300000000001n]) {
    const p = partition(n, 6);
    assert.equal(BigInt(p.count) * p.size + p.remainder, n);
    assert.ok(p.remainder >= 0n);
  }
});
test("prepared launches can retain a historical bag denomination", () => {
  const previous = partition(17590163934426n, 6, 500000n);
  assert.equal(previous.count, 35);
  assert.equal(previous.size, 500000000000n);
  assert.throws(() => partition(1n, 6, 0n));
});
test("regional placement preserves totals with at most one bag difference", () => {
  for (let count = 0; count < 1000; count++) {
    for (const odd of [false, true]) {
      const n = regionalCounts(count, odd);
      assert.equal(n.EU + n.US, count);
      assert.ok(Math.abs(n.EU - n.US) <= 1);
    }
  }
});
test("10 km radius boundaries and invalid coordinates fail correctly", () => {
  const delta = ((10000 / 6371008.8) * 180) / Math.PI;
  assert.ok(eligible({ lat: 0, lng: 0 }, { lat: delta * 0.999999, lng: 0 }));
  assert.ok(!eligible({ lat: 0, lng: 0 }, { lat: delta * 1.000001, lng: 0 }));
  assert.ok(eligible({ lat: 40, lng: -73 }, { lat: 40, lng: -73 }));
  assert.ok(!eligible({ lat: NaN, lng: 0 }, { lat: 0, lng: 0 }));
  assert.ok(!validCoordinates(91, 0));
  assert.ok(
    distanceMetres({ lat: 0, lng: 179.99 }, { lat: 0, lng: -179.99 }) < 3000,
  );
});
