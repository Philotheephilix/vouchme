import { test } from "node:test";
import assert from "node:assert/strict";
import { compute } from "./score.js";
import { breakdown } from "./explain.js";
import { BASE, CAP_POS, M_POS_DEN, M_POS_NUM, T1 } from "./constants.js";
import { anchorAccount, human, makeInput, vouch } from "./test-helpers.js";

// docs/01-trust-math.md §12.1 — the promotion table. One test per row.

test("12.1 — 1 anchor => 30, blocked (gate 2: only 1 distinct voucher)", () => {
  const out = compute(
    makeInput({
      accounts: [anchorAccount("A1"), human("U")],
      vouches: [vouch("A1", "U")],
    }),
  );
  assert.equal(out.sPlus["U"], 3_000);
  assert.equal(out.score["U"], 3_000);
  assert.equal(out.tier["U"], 0);
});

test("12.1 — 2 anchors => 50, Tier 1", () => {
  const out = compute(
    makeInput({
      accounts: [anchorAccount("A1"), anchorAccount("A2"), human("U")],
      vouches: [vouch("A1", "U"), vouch("A2", "U")],
    }),
  );
  assert.equal(out.sPlus["U"], 5_000);
  assert.equal(out.tier["U"], 1);
});

test("12.1 — 2 × T1@30 => 25, blocked (gate 1: below T1)", () => {
  // "T1@30": a voucher whose own s+ is exactly 30 (a single-anchor-vouched account — the
  // previous row, individually gate-2-blocked, but that does not stop its raw s+ from being
  // used as a contribution source: gates decide promotion/tier, not contribution eligibility).
  const out = compute(
    makeInput({
      accounts: [
        anchorAccount("A1"),
        anchorAccount("A2"),
        human("V1"),
        human("V2"),
        human("U"),
      ],
      vouches: [
        vouch("A1", "V1"),
        vouch("A2", "V2"),
        vouch("V1", "U"),
        vouch("V2", "U"),
      ],
    }),
  );
  assert.equal(out.sPlus["V1"], 3_000);
  assert.equal(out.sPlus["V2"], 3_000);
  assert.equal(out.sPlus["U"], 2_500);
  assert.equal(out.tier["U"], 0);
});

test("12.1 — 3 × T1@30 => 32.5, Tier 1", () => {
  const out = compute(
    makeInput({
      accounts: [
        anchorAccount("A1"),
        anchorAccount("A2"),
        anchorAccount("A3"),
        human("V1"),
        human("V2"),
        human("V3"),
        human("U"),
      ],
      vouches: [
        vouch("A1", "V1"),
        vouch("A2", "V2"),
        vouch("A3", "V3"),
        vouch("V1", "U"),
        vouch("V2", "U"),
        vouch("V3", "U"),
      ],
    }),
  );
  assert.equal(out.sPlus["U"], 3_250);
  assert.equal(out.tier["U"], 1);
});

test("12.1 — 2 × T1@50 => 35, Tier 1", () => {
  const out = compute(
    makeInput({
      accounts: [
        anchorAccount("A1"),
        anchorAccount("A2"),
        anchorAccount("A3"),
        anchorAccount("A4"),
        human("V1"),
        human("V2"),
        human("U"),
      ],
      vouches: [
        vouch("A1", "V1"),
        vouch("A2", "V1"),
        vouch("A3", "V2"),
        vouch("A4", "V2"),
        vouch("V1", "U"),
        vouch("V2", "U"),
      ],
    }),
  );
  assert.equal(out.sPlus["V1"], 5_000);
  assert.equal(out.sPlus["V2"], 5_000);
  assert.equal(out.sPlus["U"], 3_500);
  assert.equal(out.tier["U"], 1);
});

test("12.1 — 1 anchor + 1 T1@30 => 30.00, Tier 0, BLOCKED (corrected)", () => {
  // SPEC CORRECTION: the doc originally listed this row as "37.5, Tier 1". That is unreachable —
  // a direct anchor->U edge forces depth(U) = 1, and a "T1@30" account (score 30) can never be
  // at depth 0 (depth 0 is anchors/Tier-2 origins only, and Tier 2 needs score >= 100), so V1 is
  // at depth >= 1, not strictly lower than U's depth 1, and contributes 0.
  // s+ = 10 + 20 + 0 = 30.00. This also exposed the gate-2 bug fixed in
  // `distinctContributingVoucherCount`: under the old "count raw inbound edges" gate 2, U would
  // have reached Tier 1 on one real anchor plus one zero-weight edge — exactly the single-point-
  // of-trust hole gate 2 exists to close. Corrected gate 2 counts only *contributing* vouchers
  // (depth(voucher) < depth(target)), so U has exactly 1 contributing voucher here and gate 2
  // correctly fails.
  const out = compute(
    makeInput({
      accounts: [anchorAccount("A1"), anchorAccount("A2"), human("V1"), human("U")],
      vouches: [vouch("A2", "V1"), vouch("A1", "U"), vouch("V1", "U")],
    }),
  );
  assert.equal(out.sPlus["V1"], 3_000);
  assert.equal(out.sPlus["U"], 3_000);
  assert.equal(out.tier["U"], 0);
});

test("12.1 — 5 anchors => 110, Tier 2", () => {
  const anchors = ["A1", "A2", "A3", "A4", "A5"];
  const out = compute(
    makeInput({
      accounts: [...anchors.map((id) => anchorAccount(id)), human("U")],
      vouches: anchors.map((id) => vouch(id, "U")),
    }),
  );
  assert.equal(out.sPlus["U"], 11_000);
  assert.equal(out.tier["U"], 2);
});

test("12.1 — 8 × T1@50 => 110, Tier 2", () => {
  const vouchers = Array.from({ length: 8 }, (_, i) => `V${i}`);
  const accounts = [
    anchorAccount("A1"),
    anchorAccount("A2"),
    ...vouchers.map((id) => human(id)),
    human("U"),
  ];
  const vouches = [
    ...vouchers.map((id) => vouch("A1", id)),
    ...vouchers.map((id) => vouch("A2", id)),
    ...vouchers.map((id) => vouch(id, "U")),
  ];
  const out = compute(makeInput({ accounts, vouches }));
  for (const id of vouchers) assert.equal(out.sPlus[id], 5_000);
  assert.equal(out.sPlus["U"], 11_000);
  assert.equal(out.tier["U"], 2);
});

test("12.1 — 12 × T1@30 => 100, Tier 2 (also required test-list item #1)", () => {
  const vouchers = Array.from({ length: 12 }, (_, i) => `V${i}`);
  const accounts = [anchorAccount("A1"), ...vouchers.map((id) => human(id)), human("U")];
  const vouches = [
    ...vouchers.map((id) => vouch("A1", id)),
    ...vouchers.map((id) => vouch(id, "U")),
  ];
  const out = compute(makeInput({ accounts, vouches }));
  for (const id of vouchers) assert.equal(out.sPlus[id], 3_000);
  assert.equal(out.sPlus["U"], 10_000);
  assert.equal(out.tier["U"], 2);
});

test("12.1 — 6-account mutual ring (complete graph, no anchor path) => 10.00, blocked ×3", () => {
  // With the corrected gate 2 (contributing vouchers only), this row is blocked by all THREE
  // gates, not two: every ring member has 5 raw inbound edges, but zero are *contributing*
  // (nothing has depth < an unreachable/undefined depth), so gate 1 (score < T1), gate 2 (0
  // contributing vouchers < 2) and gate 3 (unreachable) all fail independently.
  const ids = ["R0", "R1", "R2", "R3", "R4", "R5"];
  const accounts = ids.map((id) => human(id));
  const vouches = [];
  for (const a of ids) for (const b of ids) if (a !== b) vouches.push(vouch(a, b));
  const input = makeInput({ accounts, vouches });
  const out = compute(input);
  for (const id of ids) {
    assert.equal(out.sPlus[id], BASE, `${id} should score exactly BASE (unreachable)`);
    assert.equal(out.tier[id], 0);
    assert.equal(out.depth[id], Number.POSITIVE_INFINITY, `${id} should be unreachable`);
    // observable proxy for "gate 2 fails too": despite 5 raw inbound vouches, none are counted.
    const bd = breakdown(id, input, out);
    assert.equal(bd.vouchers.length, 5);
    assert.ok(bd.vouchers.every((v) => !v.counted));
  }
});

// docs/01-trust-math.md §9.1 — depth ceilings.

test("9.1 — depth 3, 2 vouches => 27.5, blocked", () => {
  // depth 1: 2 anchors => 50.00 each (2 distinct d1 nodes)
  // depth 2: 2 × d1@50 => 35.00 each (2 distinct d2 nodes)
  // depth 3: 2 × d2@35 => 27.50 — below T1, blocked
  const accounts = [
    anchorAccount("A1"),
    anchorAccount("A2"),
    anchorAccount("A3"),
    anchorAccount("A4"),
    human("D1a"),
    human("D1b"),
    human("D2a"),
    human("D2b"),
    human("D3"),
  ];
  const vouches = [
    vouch("A1", "D1a"),
    vouch("A2", "D1a"),
    vouch("A3", "D1b"),
    vouch("A4", "D1b"),
    vouch("D1a", "D2a"),
    vouch("D1b", "D2a"),
    vouch("D1a", "D2b"),
    vouch("D1b", "D2b"),
    vouch("D2a", "D3"),
    vouch("D2b", "D3"),
  ];
  const out = compute(makeInput({ accounts, vouches }));
  assert.equal(out.sPlus["D1a"], 5_000);
  assert.equal(out.sPlus["D2a"], 3_500);
  assert.equal(out.sPlus["D3"], 2_750);
  assert.equal(out.tier["D3"], 0);
});

test("9.1 — depth 3, 3 vouches => 36.25, Tier 1", () => {
  const accounts = [
    anchorAccount("A1"),
    anchorAccount("A2"),
    anchorAccount("A3"),
    anchorAccount("A4"),
    anchorAccount("A5"),
    anchorAccount("A6"),
    human("D1a"),
    human("D1b"),
    human("D1c"),
    human("D2a"),
    human("D2b"),
    human("D2c"),
    human("D3"),
  ];
  const d1 = ["D1a", "D1b", "D1c"];
  const d2 = ["D2a", "D2b", "D2c"];
  const vouches = [
    // 2 anchors each => every d1 node scores 50.00
    vouch("A1", "D1a"),
    vouch("A2", "D1a"),
    vouch("A3", "D1b"),
    vouch("A4", "D1b"),
    vouch("A5", "D1c"),
    vouch("A6", "D1c"),
    // every d2 node vouched by exactly 2 distinct d1 nodes => 35.00 each
    vouch("D1a", "D2a"),
    vouch("D1b", "D2a"),
    vouch("D1b", "D2b"),
    vouch("D1c", "D2b"),
    vouch("D1a", "D2c"),
    vouch("D1c", "D2c"),
    // D3 vouched by all 3 d2 nodes => 36.25
    ...d2.map((d2id) => vouch(d2id, "D3")),
  ];
  const out = compute(makeInput({ accounts, vouches }));
  for (const id of d1) assert.equal(out.sPlus[id], 5_000);
  for (const id of d2) assert.equal(out.sPlus[id], 3_500);
  assert.equal(out.sPlus["D3"], 3_625);
  assert.equal(out.tier["D3"], 1);
});

// docs/01-trust-math.md §5.3 — single-file chains never promote, at any length.
//
// This is a claim about the *theoretical self-consistent fixed point* of the contraction
// f(s) = BASE + w+(s), the same kind of "greater fixed point" analysis as §5.1's cliques — not
// something a MAX_DEPTH=3, least-fixed-point BFS engine can produce directly from one long
// chain (nodes past depth 3 from the nearest real origin are simply unreachable, and score
// BASE). Verified directly here as a property of the recursion itself, using the engine's own
// exported constants for the weight formula, matching docs/10-constants.md's:
//   contribution(s) = min((s*25)/100, CAP_POS)   // truncate toward zero
test("5.3 — single-vouch chain recursion converges to 13.33 and never reaches T1", () => {
  function contribution(s: number): number {
    return Math.min(Math.trunc((s * M_POS_NUM) / M_POS_DEN), CAP_POS);
  }
  let s = 100_00; // start from an anchor-strength seed; the limit does not depend on the seed
  for (let i = 0; i < 200; i++) {
    s = BASE + contribution(s);
  }
  assert.equal(s, 1_333); // 13.33, the fixed point of the truncated integer recursion
  assert.ok(s < T1, "a single-vouch chain must never reach T1, at any length");

  // Convergence is from *above* for a high seed: monotone non-increasing until the fixed point.
  let prev = 100_00;
  let cur = BASE + contribution(prev);
  while (cur !== prev) {
    assert.ok(cur <= prev);
    prev = cur;
    cur = BASE + contribution(prev);
  }
  assert.equal(cur, 1_333);
});
