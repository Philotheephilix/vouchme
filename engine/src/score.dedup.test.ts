import { test } from "node:test";
import assert from "node:assert/strict";
import { compute } from "./score.js";
import { breakdown } from "./explain.js";
import { anchorAccount, human, makeInput } from "./test-helpers.js";

// Duplicate (voucher, vouchee) vouch records must be deduplicated to a single canonical edge
// before the s⁺ sum, gate 2, and the depth BFS see the edge list. Here 2 distinct anchors vouch
// for carol and one anchor's single vouch is replayed as 4 duplicate records (an indexer replay,
// not a contract-level double-vouch). Tier 2 requires 6 distinct anchors at base=20
// (docs/01-trust-math.md §12.1), so 2 anchors must never be enough however often one of their
// edges is repeated in the input array.
test("R-2 — a duplicated vouch edge does not inflate s+ beyond what its distinct source contributes once", () => {
  const out = compute(
    makeInput({
      now: 1000,
      accounts: [anchorAccount("anchorA"), anchorAccount("anchorB"), human("carol")],
      vouches: [
        { voucher: "anchorA", vouchee: "carol", active: true },
        { voucher: "anchorB", vouchee: "carol", active: true },
        { voucher: "anchorB", vouchee: "carol", active: true },
        { voucher: "anchorB", vouchee: "carol", active: true },
        { voucher: "anchorB", vouchee: "carol", active: true },
      ],
    }),
  );
  // 2 distinct anchors, each contributing capped 20.00: s+ = 20 + 20 + 20 = 60.00 (Tier 1), never
  // 140.00 / Tier 2 — that would require 6 DISTINCT anchors (§12.1), not 1 anchor's edge summed 4×.
  assert.equal(out.sPlus["carol"], 6_000);
  assert.equal(out.tier["carol"], 1);
  assert.ok(!out.origins.includes("carol"), "carol must not become an origin on 2 real anchors");
});

// The same duplication must not change which accounts count toward gate 2's distinct-voucher
// requirement either.
test("R-2 — gate 2's distinct-voucher count is unaffected by duplicate edges (already correct; must stay correct)", () => {
  const out = compute(
    makeInput({
      now: 1000,
      accounts: [anchorAccount("anchorA"), anchorAccount("anchorB"), human("carol")],
      vouches: [
        { voucher: "anchorA", vouchee: "carol", active: true },
        { voucher: "anchorB", vouchee: "carol", active: true },
        { voucher: "anchorB", vouchee: "carol", active: true },
      ],
    }),
  );
  assert.equal(out.tier["carol"], 1); // 2 distinct contributing vouchers, s+ = 60.00 >= T1
});

// Tie-break for conflicting duplicate records of the same pair (one active, one not): the engine
// has no timestamp field on Vouch to determine "latest" (resolving that already happened in the
// caller, per the type's own doc comment on `active`), so the documented, deterministic tie-break
// is "prefer active" — the deduplicated edge counts if ANY duplicate record for the pair is
// active. Verified order-independently (I-5): the result must not depend on which record (active
// or inactive) appears first in the input array.
test("R-2 — conflicting duplicate records for the same pair: the active one wins, regardless of order", () => {
  const base = {
    now: 1000,
    accounts: [anchorAccount("anchorA"), anchorAccount("anchorB"), human("carol")],
  };
  const activeFirst = compute(
    makeInput({
      ...base,
      vouches: [
        { voucher: "anchorA", vouchee: "carol", active: true },
        { voucher: "anchorB", vouchee: "carol", active: true },
        { voucher: "anchorB", vouchee: "carol", active: false },
      ],
    }),
  );
  const inactiveFirst = compute(
    makeInput({
      ...base,
      vouches: [
        { voucher: "anchorA", vouchee: "carol", active: true },
        { voucher: "anchorB", vouchee: "carol", active: false },
        { voucher: "anchorB", vouchee: "carol", active: true },
      ],
    }),
  );
  // Both must land on 2 contributing anchors (60.00), because in both cases at least one of the
  // duplicate anchorB->carol records is active.
  assert.equal(activeFirst.sPlus["carol"], 6_000);
  assert.equal(inactiveFirst.sPlus["carol"], 6_000);
  assert.equal(JSON.stringify(activeFirst), JSON.stringify(inactiveFirst));
});

// breakdown() reads the raw EngineInput.vouches directly, independent of compute()'s internal
// edge list — a duplicated (voucher, vouchee) record must not show up as multiple rows in the
// UI's "why is my score what it is" explanation either, or a user auditing their own score would
// see phantom duplicate endorsements from the same person.
test("R-2 — breakdown() shows a duplicated vouch edge as exactly one row, not one per duplicate", () => {
  const input = makeInput({
    now: 1000,
    accounts: [anchorAccount("anchorA"), anchorAccount("anchorB"), human("carol")],
    vouches: [
      { voucher: "anchorA", vouchee: "carol", active: true },
      { voucher: "anchorB", vouchee: "carol", active: true },
      { voucher: "anchorB", vouchee: "carol", active: true },
      { voucher: "anchorB", vouchee: "carol", active: true },
    ],
  });
  const out = compute(input);
  const bd = breakdown("carol", input, out);
  assert.equal(bd.vouchers.length, 2, "one row per DISTINCT voucher, not one row per input record");
  assert.deepEqual(
    bd.vouchers.map((v) => v.voucher).sort(),
    ["anchorA", "anchorB"],
  );
});
