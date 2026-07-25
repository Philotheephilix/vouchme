import { test } from "node:test";
import assert from "node:assert/strict";
import { compute } from "./score.js";
import { breakdown } from "./explain.js";
import { BASE, CAP_POS, M_POS_DEN, M_POS_NUM, T1 } from "./constants.js";
import { anchorAccount, human, makeInput, vouch } from "./test-helpers.js";

// docs/01-trust-math.md §12.1 — the promotion table. One test per row.

test("12.1 — 1 anchor => 40, blocked (gate 1: below T1; gate 2: only 1 distinct voucher)", () => {
  const out = compute(
    makeInput({
      accounts: [anchorAccount("A1"), human("U")],
      vouches: [vouch("A1", "U")],
    }),
  );
  assert.equal(out.sPlus["U"], 4_000);
  assert.equal(out.score["U"], 4_000);
  assert.equal(out.tier["U"], 0);
});

test("12.1 — 2 anchors => 60, Tier 1", () => {
  const out = compute(
    makeInput({
      accounts: [anchorAccount("A1"), anchorAccount("A2"), human("U")],
      vouches: [vouch("A1", "U"), vouch("A2", "U")],
    }),
  );
  assert.equal(out.sPlus["U"], 6_000);
  assert.equal(out.tier["U"], 1);
});

test("12.1 — 2 × T1@60 => 50, blocked (gate 1: below T1) — two is never enough", () => {
  // "T1@60": a voucher whose own s+ is exactly 60 (a 2-anchor-vouched account — see the previous
  // row). Two such vouchers land U at 50.00, strictly below the new T1 = 55.00: at base = 20 the
  // published property "two vouches is never enough from ordinary members, three is" now bites
  // one level in, not just at depth 3 (see docs/01-trust-math.md §13 sensitivity / errata E-16).
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
  assert.equal(out.sPlus["V1"], 6_000);
  assert.equal(out.sPlus["V2"], 6_000);
  assert.equal(out.sPlus["U"], 5_000);
  assert.equal(out.tier["U"], 0);
});

test("12.1 — 3 × T1@60 => 65, Tier 1 — three is enough", () => {
  const out = compute(
    makeInput({
      accounts: [
        anchorAccount("A1"),
        anchorAccount("A2"),
        anchorAccount("A3"),
        anchorAccount("A4"),
        anchorAccount("A5"),
        anchorAccount("A6"),
        human("V1"),
        human("V2"),
        human("V3"),
        human("U"),
      ],
      vouches: [
        vouch("A1", "V1"),
        vouch("A2", "V1"),
        vouch("A3", "V2"),
        vouch("A4", "V2"),
        vouch("A5", "V3"),
        vouch("A6", "V3"),
        vouch("V1", "U"),
        vouch("V2", "U"),
        vouch("V3", "U"),
      ],
    }),
  );
  assert.equal(out.sPlus["V1"], 6_000);
  assert.equal(out.sPlus["V2"], 6_000);
  assert.equal(out.sPlus["V3"], 6_000);
  assert.equal(out.sPlus["U"], 6_500);
  assert.equal(out.tier["U"], 1);
});

test("12.1 — 1 anchor + 1 non-contributing peer => 40.00, Tier 0, BLOCKED (both gates fail)", () => {
  // A direct anchor->U edge forces depth(U) = 1, and V1 (score 40.00, itself individually
  // gate-2-blocked — see the "1 anchor" row above) can never be at depth 0 (depth 0 is
  // anchors/Tier-2 origins only, and Tier 2 needs score >= 140), so V1 sits at depth >= 1, not
  // strictly lower than U's depth 1, and contributes 0.
  // s+ = 20 + 20 + 0 = 40.00.
  //
  // Under the OLD constants (base=10, T1=30) this exact shape landed exactly ON the threshold
  // (10 + 20 + 0 = 30 = T1) — a single real anchor plus one worthless edge was *just* enough to
  // clear gate 1, and only the corrected gate 2 (counting contributing vouchers, not raw inbound
  // edges) blocked it. At base=20 / T1=55, base + cap+ = 20 + 20 = 40 < 55 — a single contributing
  // voucher, however strong (capped at 20 regardless), can NEVER reach T1 alone anymore, so this
  // row now fails gate 1 too, not only gate 2. Gate 2 remains the general, base-independent rule
  // (errata E-16): the exact-threshold coincidence was an artifact of the old numbers, not
  // something gate 2's correctness ever depended on.
  const out = compute(
    makeInput({
      accounts: [anchorAccount("A1"), anchorAccount("A2"), human("V1"), human("U")],
      vouches: [vouch("A2", "V1"), vouch("A1", "U"), vouch("V1", "U")],
    }),
  );
  assert.equal(out.sPlus["V1"], 4_000);
  assert.equal(out.sPlus["U"], 4_000);
  assert.equal(out.tier["U"], 0);
});

test("12.1 — 6 anchors => 140, Tier 2", () => {
  const anchors = ["A1", "A2", "A3", "A4", "A5", "A6"];
  const out = compute(
    makeInput({
      accounts: [...anchors.map((id) => anchorAccount(id)), human("U")],
      vouches: anchors.map((id) => vouch(id, "U")),
    }),
  );
  assert.equal(out.sPlus["U"], 14_000);
  assert.equal(out.tier["U"], 2);
});

test("12.1 — 8 × T1@60 => 140, Tier 2", () => {
  const anchors = ["A1", "A2"];
  const vouchers = Array.from({ length: 8 }, (_, i) => `V${i}`);
  const accounts = [
    ...anchors.map((id) => anchorAccount(id)),
    ...vouchers.map((id) => human(id)),
    human("U"),
  ];
  const vouches = [
    ...vouchers.flatMap((id) => anchors.map((a) => vouch(a, id))),
    ...vouchers.map((id) => vouch(id, "U")),
  ];
  const out = compute(makeInput({ accounts, vouches }));
  for (const id of vouchers) assert.equal(out.sPlus[id], 6_000);
  assert.equal(out.sPlus["U"], 14_000);
  assert.equal(out.tier["U"], 2);
});

test("12.1 — 12 × 1-anchor@40 => 140, Tier 2 (also required test-list item #1)", () => {
  const vouchers = Array.from({ length: 12 }, (_, i) => `V${i}`);
  const accounts = [anchorAccount("A1"), ...vouchers.map((id) => human(id)), human("U")];
  const vouches = [
    ...vouchers.map((id) => vouch("A1", id)),
    ...vouchers.map((id) => vouch(id, "U")),
  ];
  const out = compute(makeInput({ accounts, vouches }));
  for (const id of vouchers) assert.equal(out.sPlus[id], 4_000);
  assert.equal(out.sPlus["U"], 14_000);
  assert.equal(out.tier["U"], 2);
});

test("12.1 — 7-account mutual ring (complete graph, no anchor path) => 20.00, blocked ×3", () => {
  // §5.1: at base=20, the smallest complete-graph clique that would self-certify Tier 2
  // (S = 20 + 20n >= 140) if depth ordering did not exclude it is n=6 contributing peers, i.e. a
  // 7-account ring (up from 6 accounts at the old base=10/T2=100 — see errata E-16). With the
  // corrected gate 2 (contributing vouchers only), this row is blocked by all THREE gates: every
  // ring member has 6 raw inbound edges, but zero are *contributing* (nothing has depth < an
  // unreachable/undefined depth), so gate 1 (score < T1), gate 2 (0 contributing vouchers < 2)
  // and gate 3 (unreachable) all fail independently.
  const ids = ["R0", "R1", "R2", "R3", "R4", "R5", "R6"];
  const accounts = ids.map((id) => human(id));
  const vouches = [];
  for (const a of ids) for (const b of ids) if (a !== b) vouches.push(vouch(a, b));
  const input = makeInput({ accounts, vouches });
  const out = compute(input);
  for (const id of ids) {
    assert.equal(out.sPlus[id], BASE, `${id} should score exactly BASE (unreachable)`);
    assert.equal(out.tier[id], 0);
    assert.equal(out.depth[id], Number.POSITIVE_INFINITY, `${id} should be unreachable`);
    // observable proxy for "gate 2 fails too": despite 6 raw inbound vouches, none are counted.
    const bd = breakdown(id, input, out);
    assert.equal(bd.vouchers.length, 6);
    assert.ok(bd.vouchers.every((v) => !v.counted));
  }
});

// docs/01-trust-math.md §9.1 — depth ceilings.

test("9.1 — depth 2, 2 × d1@60 => 50, blocked (the ladder shifts one level in — errata E-16)", () => {
  // depth 1: 2 anchors => 60.00 each. depth 2: 2 × d1@60 => 50.00 — below T1 (55.00), blocked.
  // Under the OLD constants (base=10, T1=30) this exact shape (2 × d1@50) gave 35.00, comfortably
  // Tier 1 — "two is never enough" didn't bite until depth 3 (see the next test below). At
  // base=20 / T1=55 it now bites one level earlier, at depth 2, because base doubled (10 -> 20,
  // a full extra +20 flat) while a depth-1 voucher's capped contribution only grew from 12.5 to
  // 15.00 per source (m+/cap+ unchanged) — T1 had to move for the "two is never enough" property
  // to survive at all, and moving it shifted exactly where the property first bites.
  const accounts = [
    anchorAccount("A1"),
    anchorAccount("A2"),
    anchorAccount("A3"),
    anchorAccount("A4"),
    human("D1a"),
    human("D1b"),
    human("D2"),
  ];
  const vouches = [
    vouch("A1", "D1a"),
    vouch("A2", "D1a"),
    vouch("A3", "D1b"),
    vouch("A4", "D1b"),
    vouch("D1a", "D2"),
    vouch("D1b", "D2"),
  ];
  const out = compute(makeInput({ accounts, vouches }));
  assert.equal(out.sPlus["D1a"], 6_000);
  assert.equal(out.sPlus["D1b"], 6_000);
  assert.equal(out.sPlus["D2"], 5_000);
  assert.equal(out.tier["D2"], 0);
});

test("9.1 — depth 3, 2 vouches => 45.00, blocked", () => {
  // depth 1: 2 anchors => 60.00 each (2 distinct d1 nodes)
  // depth 2: 2 × d1@60 => 50.00 each (2 distinct d2 nodes)
  // depth 3: 2 × d2@50 => 45.00 — below T1 (55.00), blocked
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
  assert.equal(out.sPlus["D1a"], 6_000);
  assert.equal(out.sPlus["D2a"], 5_000);
  assert.equal(out.sPlus["D3"], 4_500);
  assert.equal(out.tier["D3"], 0);
});

test("9.1 — depth 3, 3 vouches => 57.50, Tier 1", () => {
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
    // 2 anchors each => every d1 node scores 60.00
    vouch("A1", "D1a"),
    vouch("A2", "D1a"),
    vouch("A3", "D1b"),
    vouch("A4", "D1b"),
    vouch("A5", "D1c"),
    vouch("A6", "D1c"),
    // every d2 node vouched by exactly 2 distinct d1 nodes => 50.00 each
    vouch("D1a", "D2a"),
    vouch("D1b", "D2a"),
    vouch("D1b", "D2b"),
    vouch("D1c", "D2b"),
    vouch("D1a", "D2c"),
    vouch("D1c", "D2c"),
    // D3 vouched by all 3 d2 nodes => 57.50
    ...d2.map((d2id) => vouch(d2id, "D3")),
  ];
  const out = compute(makeInput({ accounts, vouches }));
  for (const id of d1) assert.equal(out.sPlus[id], 6_000);
  for (const id of d2) assert.equal(out.sPlus[id], 5_000);
  assert.equal(out.sPlus["D3"], 5_750);
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
test("5.3 — single-vouch chain recursion converges to 26.66 and never reaches T1", () => {
  function contribution(s: number): number {
    return Math.min(Math.trunc((s * M_POS_NUM) / M_POS_DEN), CAP_POS);
  }
  let s = 100_00; // start from an anchor-strength seed; the limit does not depend on the seed
  for (let i = 0; i < 200; i++) {
    s = BASE + contribution(s);
  }
  assert.equal(s, 2_666); // 26.66 (theoretical 20/(1-0.25) = 26.67), the fixed point of the
  // truncated integer recursion — truncation floors it fractionally below the continuous value.
  assert.ok(s < T1, "a single-vouch chain must never reach T1, at any length");

  // Convergence is from *above* for a high seed: monotone non-increasing until the fixed point.
  let prev = 100_00;
  let cur = BASE + contribution(prev);
  while (cur !== prev) {
    assert.ok(cur <= prev);
    prev = cur;
    cur = BASE + contribution(prev);
  }
  assert.equal(cur, 2_666);
});
