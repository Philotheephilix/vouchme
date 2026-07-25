import { test } from "node:test";
import assert from "node:assert/strict";
import { compute } from "./score.js";
import { SECONDS_PER_DAY } from "./constants.js";
import {
  anchorAccount,
  human,
  makeInput,
  platformAccount,
  platformVouch,
  report,
  vouch,
} from "./test-helpers.js";

const DAY = SECONDS_PER_DAY;

// docs/01-trust-math.md §12.2 — reports applied. One test per row, all against a base scenario
// of "U vouched by 2 anchors" (s+ = 50.00), except the Tier-2 rows which use 5 anchors (110.00).

function twoAnchorScenario(now: number, reports: ReturnType<typeof report>[]) {
  return makeInput({
    now,
    accounts: [anchorAccount("A1"), anchorAccount("A2"), anchorAccount("A3"), human("U")],
    vouches: [vouch("A1", "U"), vouch("A2", "U")],
    reports,
  });
}

test("12.2 — pending report from an anchor: score unchanged, scoreAtRisk drops", () => {
  const out = compute(
    twoAnchorScenario(0, [report("r1", "A3", "U", "pending")]),
  );
  assert.equal(out.score["U"], 5_000);
  assert.equal(out.scoreAtRisk["U"], 1_000);
  assert.equal(out.tier["U"], 1); // pending never changes tier — an accusation is not a verdict
});

test("12.2 — that report upheld: score drops to 10, Tier 0 (one maximal report ends Tier 1)", () => {
  const out = compute(
    twoAnchorScenario(0, [report("r1", "A3", "U", "upheld", { upheldAt: 0 })]),
  );
  assert.equal(out.score["U"], 1_000);
  assert.equal(out.tier["U"], 0);
});

test("12.2 — upheld report, 90 days later: score 30, Tier 1 (linear decay, half gone)", () => {
  const now = 90 * DAY;
  const out = compute(
    twoAnchorScenario(now, [report("r1", "A3", "U", "upheld", { upheldAt: 0 })]),
  );
  assert.equal(out.score["U"], 3_000);
  assert.equal(out.tier["U"], 1);
});

test("12.2 — upheld report, 180 days later: score 50, Tier 1 (fully rehabilitated)", () => {
  const now = 180 * DAY;
  const out = compute(
    twoAnchorScenario(now, [report("r1", "A3", "U", "upheld", { upheldAt: 0 })]),
  );
  assert.equal(out.score["U"], 5_000);
  assert.equal(out.tier["U"], 1);
});

function fiveAnchorScenario(reports: ReturnType<typeof report>[]) {
  const anchors = ["A1", "A2", "A3", "A4", "A5"];
  return makeInput({
    now: 0,
    accounts: [...anchors.map((id) => anchorAccount(id)), human("U")],
    vouches: anchors.map((id) => vouch(id, "U")),
    reports,
  });
}

test("12.2 — Tier 2 (110): 1 upheld from a P2 platform => 70, Tier 1", () => {
  // A P2 platform: vouched by 8 anchors => s_P = 160.00 (P2 >= 150).
  const platformAnchors = Array.from({ length: 8 }, (_, i) => `PA${i}`);
  const humanAnchors = ["A1", "A2", "A3", "A4", "A5"];
  const out = compute(
    makeInput({
      now: 0,
      accounts: [
        ...humanAnchors.map((id) => anchorAccount(id)),
        ...platformAnchors.map((id) => anchorAccount(id)),
        human("U"),
        platformAccount("P2plat"),
      ],
      vouches: humanAnchors.map((id) => vouch(id, "U")),
      platformVouches: platformAnchors.map((id) => platformVouch(id, "P2plat")),
      reports: [report("r1", "P2plat", "U", "upheld", { upheldAt: 0, queried: true })],
    }),
  );
  assert.equal(out.sPlatform["P2plat"], 16_000);
  assert.equal(out.platformTier["P2plat"], 2);
  assert.equal(out.sPlus["U"], 11_000);
  assert.equal(out.score["U"], 7_000);
  assert.equal(out.tier["U"], 1);
});

test("12.2 — Tier 2 (110): 2 upheld => 30, Tier 1", () => {
  const out = compute(
    fiveAnchorScenario([
      report("r1", "A1", "U", "upheld", { upheldAt: 0 }),
      report("r2", "A2", "U", "upheld", { upheldAt: 0 }),
    ]),
  );
  assert.equal(out.score["U"], 3_000);
  assert.equal(out.tier["U"], 1);
});

test("12.2 — Tier 2 (110): 3 upheld => 10, Tier 0 (floored at base, not 0)", () => {
  const out = compute(
    fiveAnchorScenario([
      report("r1", "A1", "U", "upheld", { upheldAt: 0 }),
      report("r2", "A2", "U", "upheld", { upheldAt: 0 }),
      report("r3", "A3", "U", "upheld", { upheldAt: 0 }),
    ]),
  );
  assert.equal(out.score["U"], 1_000);
  assert.ok(out.score["U"]! >= 1_000, "score must never fall below base (I-9)");
  assert.equal(out.tier["U"], 0);
});

test("12.2 — Tier 2 (110): 5 upheld => 10, Tier 0 (top-3 cap; reports 4 and 5 change nothing)", () => {
  const withThree = compute(
    fiveAnchorScenario([
      report("r1", "A1", "U", "upheld", { upheldAt: 0 }),
      report("r2", "A2", "U", "upheld", { upheldAt: 0 }),
      report("r3", "A3", "U", "upheld", { upheldAt: 0 }),
    ]),
  );
  const withFive = compute(
    fiveAnchorScenario([
      report("r1", "A1", "U", "upheld", { upheldAt: 0 }),
      report("r2", "A2", "U", "upheld", { upheldAt: 0 }),
      report("r3", "A3", "U", "upheld", { upheldAt: 0 }),
      report("r4", "A4", "U", "upheld", { upheldAt: 0 }),
      report("r5", "A5", "U", "upheld", { upheldAt: 0 }),
    ]),
  );
  assert.equal(withFive.score["U"], 1_000);
  assert.equal(withFive.score["U"], withThree.score["U"]);
  assert.equal(withFive.tier["U"], 0);
});

test("12.2 — report from a voided reporter has zero effect (35 stays 35, Tier 1)", () => {
  // U at depth 2, s+ = 35.00 (2 × d1@50). Reporter R is Tier 1 (vouched by 2 anchors, s+=50)
  // but is itself currently under an upheld report, so R's outgoing reports are void.
  const out = compute(
    makeInput({
      now: 0,
      accounts: [
        anchorAccount("A1"),
        anchorAccount("A2"),
        anchorAccount("A3"),
        anchorAccount("A4"),
        human("D1a"),
        human("D1b"),
        human("R"),
        human("U"),
      ],
      vouches: [
        vouch("A1", "D1a"),
        vouch("A2", "D1a"),
        vouch("A3", "D1b"),
        vouch("A4", "D1b"),
        vouch("D1a", "U"),
        vouch("D1b", "U"),
        vouch("A1", "R"),
        vouch("A2", "R"),
      ],
      reports: [
        report("against-R", "A3", "R", "upheld", { upheldAt: 0 }), // voids R's own reports
        report("r-from-R", "R", "U", "upheld", { upheldAt: 0 }),
      ],
    }),
  );
  assert.equal(out.sPlus["U"], 3_500);
  assert.equal(out.score["U"], 3_500);
  assert.equal(out.tier["U"], 1);
  assert.equal(out.reportWeights["r-from-R"]!.valid, false);
  assert.equal(out.reportWeights["r-from-R"]!.voidReason, "reporter_voided");
});

test("12.2 — report from a platform against one of its own vouchers is void (COI)", () => {
  const out = compute(
    makeInput({
      now: 0,
      accounts: [
        anchorAccount("A1"),
        anchorAccount("A2"),
        anchorAccount("A3"),
        anchorAccount("A4"),
        human("D1a"),
        human("D1b"),
        human("U"),
        platformAccount("P"),
      ],
      vouches: [
        vouch("A1", "D1a"),
        vouch("A2", "D1a"),
        vouch("A3", "D1b"),
        vouch("A4", "D1b"),
        vouch("D1a", "U"),
        vouch("D1b", "U"),
      ],
      platformVouches: [platformVouch("U", "P")], // U vouches for P
      reports: [report("r1", "P", "U", "upheld", { upheldAt: 0, queried: true })],
    }),
  );
  assert.equal(out.sPlus["U"], 3_500);
  assert.equal(out.score["U"], 3_500);
  assert.equal(out.tier["U"], 1);
  assert.equal(out.reportWeights["r1"]!.valid, false);
  assert.equal(out.reportWeights["r1"]!.voidReason, "platform_conflict_of_interest");
});

// Invariant I-12: at most TOP_K (3) reports affect any target, however many are filed.
test("I-12 — 20 reports filed against one target, only 3 apply", () => {
  const anchors = ["A1", "A2", "A3", "A4", "A5"];
  const reporterAnchors = Array.from({ length: 20 }, (_, i) => `R${i}`);
  const reports = reporterAnchors.map((id, i) =>
    report(`rep${i}`, id, "U", "upheld", { upheldAt: 0 }),
  );
  const out = compute(
    makeInput({
      now: 0,
      accounts: [
        ...anchors.map((id) => anchorAccount(id)),
        ...reporterAnchors.map((id) => anchorAccount(id)),
        human("U"),
      ],
      vouches: anchors.map((id) => vouch(id, "U")),
      reports,
    }),
  );
  assert.equal(out.sPlus["U"], 11_000);
  // every report is individually valid and weighs the capped max (40.00), but only 3 count
  const counted = Object.values(out.reportWeights).filter((r) => r.countedTowardScore);
  assert.equal(counted.length, 3);
  assert.equal(out.score["U"], Math.max(1_000, 11_000 - 3 * 4_000));
  assert.equal(out.score["U"], 1_000);
});
