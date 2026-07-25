import { test } from "node:test";
import assert from "node:assert/strict";
import { tenureCenti } from "./tenure.js";
import { E_HALF, T_MAX_CENTI, BASE, T1 } from "./constants.js";

// docs/16-presence-drip.md §4 worked table, corrected (the printed table is authoritative; the
// doc's own halving-band pseudocode had a truncate-before-subtract bug — see tenure.ts).
test("tenureCenti — exact table (16-presence-drip.md §4)", () => {
  assert.equal(tenureCenti(0), 0);
  assert.equal(tenureCenti(120), 41);
  assert.equal(tenureCenti(360), 125);
  assert.equal(tenureCenti(720), 250);
  assert.equal(tenureCenti(1440), 375);
  assert.equal(tenureCenti(2160), 437);
  assert.equal(tenureCenti(2880), 468);
});

test("tenureCenti — monotone non-decreasing (I-18: tenure never decreases with more epochs)", () => {
  let prev = -1;
  for (let e = 0; e <= 20_000; e += 37) {
    const t = tenureCenti(e);
    assert.ok(t >= prev, `tenureCenti(${e}) = ${t} should be >= previous ${prev}`);
    assert.ok(t <= T_MAX_CENTI, `tenureCenti(${e}) = ${t} should never exceed T_MAX_CENTI`);
    prev = t;
  }
});

test("tenureCenti — saturates to exactly T_MAX_CENTI at k=16 half-lives and beyond", () => {
  assert.equal(tenureCenti(E_HALF * 16), T_MAX_CENTI);
  assert.equal(tenureCenti(E_HALF * 16 + 1), T_MAX_CENTI);
  assert.equal(tenureCenti(E_HALF * 1000), T_MAX_CENTI);
});

// Invariant I-17: base + T_MAX < T1, so presence alone can never promote anyone, at any age.
test("I-17 (tenure half): base + T_MAX_CENTI < T1 — presence alone can never promote", () => {
  assert.ok(BASE + T_MAX_CENTI < T1);
  assert.equal(BASE + T_MAX_CENTI, 1_500);
});

test("tenureCenti — rejects negative or non-integer input", () => {
  assert.throws(() => tenureCenti(-1));
  assert.throws(() => tenureCenti(1.5));
  assert.throws(() => tenureCenti(Number.NaN));
});
