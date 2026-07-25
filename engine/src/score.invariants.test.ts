import { test } from "node:test";
import assert from "node:assert/strict";
import { compute } from "./score.js";
import { breakdown } from "./explain.js";
import { BASE, T1 } from "./constants.js";
import { tenureCenti } from "./tenure.js";
import {
  anchorAccount,
  human,
  makeInput,
  platformAccount,
  report,
  vouch,
} from "./test-helpers.js";
import type { EngineInput } from "./types.js";

// I-2: A complete subgraph with no anchor path scores exactly BASE + tenure, and never reaches T1.
test("I-2 — 7-account complete ring, no anchor path, scores exactly BASE + tenure", () => {
  // 7 accounts: the smallest complete-graph clique that would self-certify Tier 2 if depth
  // ordering did not exclude it (docs/01-trust-math.md §5.1), and the canonical ring size used
  // across the docs and tests.
  const ids = ["R0", "R1", "R2", "R3", "R4", "R5", "R6"];

  // zero-tenure variant
  const zeroInput = makeInput({
    accounts: ids.map((id) => human(id)),
    vouches: ids.flatMap((a) => ids.filter((b) => b !== a).map((b) => vouch(a, b))),
  });
  const zero = compute(zeroInput);
  for (const id of ids) {
    assert.equal(zero.sPlus[id], BASE);
    assert.equal(zero.score[id], BASE);
    assert.equal(zero.tier[id], 0);
    assert.ok(zero.score[id]! < T1);
    // all three gates fail independently: score < T1 (gate 1), unreachable (gate 3), and zero of
    // the 6 raw inbound vouches are contributing, so gate 2 fails as well.
    const bd = breakdown(id, zeroInput, zero);
    assert.equal(bd.vouchers.length, 6);
    assert.ok(bd.vouchers.every((v) => !v.counted));
  }

  // nonzero-tenure variant: presence alone still can't bootstrap the ring past BASE + tenure
  const epochs = 2_880; // 720 days present
  const expectedFloor = BASE + tenureCenti(epochs);
  const withTenure = compute(
    makeInput({
      accounts: ids.map((id) => human(id, { epochsClaimed: epochs })),
      vouches: ids.flatMap((a) => ids.filter((b) => b !== a).map((b) => vouch(a, b))),
    }),
  );
  for (const id of ids) {
    assert.equal(withTenure.sPlus[id], expectedFloor);
    assert.equal(withTenure.score[id], expectedFloor);
    assert.equal(withTenure.tier[id], 0);
    assert.ok(withTenure.score[id]! < T1, "tenure alone must never promote (I-17)");
  }
});

// I-5: order-independence — shuffle edges and accounts, identical output.
test("I-5 — shuffling account/edge order produces byte-identical output", () => {
  const anchors = ["A1", "A2", "A3", "A4", "A5"];
  const humans = ["U1", "U2", "U3", "U4"];
  const platforms = ["P1"];

  const accounts = [
    ...anchors.map((id) => anchorAccount(id)),
    ...humans.map((id) => human(id, { epochsClaimed: 500 })),
    ...platforms.map((id) => platformAccount(id)),
  ];
  const vouchEdges = [
    vouch("A1", "U1"),
    vouch("A2", "U1"),
    vouch("A3", "U2"),
    vouch("U1", "U3"),
    vouch("U2", "U3"),
    vouch("U1", "U4"),
    vouch("U2", "U4"),
    vouch("U3", "U4"),
  ];
  const reports = [
    report("r1", "A4", "U3", "upheld", { upheldAt: 1000 }),
    report("r2", "A5", "U4", "pending"),
  ];

  const inputA: EngineInput = makeInput({ now: 5_000, accounts, vouches: vouchEdges, reports });

  function shuffled<T>(arr: T[], seed: number): T[] {
    const copy = [...arr];
    let s = seed;
    for (let i = copy.length - 1; i > 0; i--) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      const j = s % (i + 1);
      [copy[i], copy[j]] = [copy[j]!, copy[i]!];
    }
    return copy;
  }

  const inputB: EngineInput = makeInput({
    now: 5_000,
    accounts: shuffled(accounts, 42),
    vouches: shuffled(vouchEdges, 7),
    reports: shuffled(reports, 99),
  });

  const outA = compute(inputA);
  const outB = compute(inputB);
  assert.equal(JSON.stringify(outA), JSON.stringify(outB));
});

// I-9: score never falls below base for an enrolled active human, and never below 0 for a
// platform, and this floor is respected even under maximal report pressure.
test("I-9 — score never falls below the floor, even under maximal report pressure", () => {
  const anchors = Array.from({ length: 5 }, (_, i) => `A${i}`);
  const reportAnchors = Array.from({ length: 10 }, (_, i) => `R${i}`);
  const out = compute(
    makeInput({
      now: 0,
      accounts: [
        ...anchors.map((id) => anchorAccount(id)),
        ...reportAnchors.map((id) => anchorAccount(id)),
        human("U", { epochsClaimed: 360 }),
      ],
      vouches: anchors.map((id) => vouch(id, "U")),
      reports: reportAnchors.map((id, i) =>
        report(`rep${i}`, id, "U", "upheld", { upheldAt: 0 }),
      ),
    }),
  );
  const floor = BASE + tenureCenti(360);
  assert.equal(out.score["U"], floor);
  assert.ok(out.score["U"]! >= floor);

  const platformOut = compute(
    makeInput({
      now: 0,
      accounts: [...reportAnchors.map((id) => anchorAccount(id)), platformAccount("P")],
      platformVouches: [],
      reports: reportAnchors.map((id, i) =>
        report(`prep${i}`, id, "P", "upheld", { upheldAt: 0, queried: true }),
      ),
    }),
  );
  assert.equal(platformOut.sPlatform["P"], 0);
  assert.ok(platformOut.sPlatform["P"]! >= 0);
});

// I-10: running the pipeline twice on identical inputs is idempotent, and the engine is pure
// (does not mutate its input).
test("I-10 — running compute twice on identical input is idempotent and input is not mutated", () => {
  const input = makeInput({
    now: 1_000,
    accounts: [anchorAccount("A1"), anchorAccount("A2"), human("U", { epochsClaimed: 100 })],
    vouches: [vouch("A1", "U"), vouch("A2", "U")],
    reports: [report("r1", "A1", "U", "pending")],
  });
  const before = JSON.stringify(input);

  const out1 = compute(input);
  const out2 = compute(input);

  assert.equal(JSON.stringify(out1), JSON.stringify(out2));
  assert.equal(JSON.stringify(input), before, "compute() must not mutate its input");
});

// I-17: an account with unbounded tenure and zero vouches scores exactly 25.00 (2500 centi) and
// is Tier 0 — presence alone can never promote anyone, at any age.
test("I-17 — 1,000,000 claimed epochs + zero vouches => score 25 (2500 centi), Tier 0", () => {
  const out = compute(
    makeInput({
      accounts: [human("Lonely", { epochsClaimed: 1_000_000 })],
    }),
  );
  assert.equal(out.sPlus["Lonely"], 2_500);
  assert.equal(out.score["Lonely"], 2_500);
  assert.equal(out.scoreAtRisk["Lonely"], 2_500);
  assert.equal(out.tier["Lonely"], 0);
});
