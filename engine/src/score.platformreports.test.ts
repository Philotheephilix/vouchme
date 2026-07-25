import { test } from "node:test";
import assert from "node:assert/strict";
import { compute } from "./score.js";
import { anchorAccount, human, makeInput, platformAccount, platformVouch, report } from "./test-helpers.js";

// R-3 (docs/97-review-engine-app.md; §17 case 4): "A platform vouches for, or reports, another
// platform" is forbidden — otherwise two platforms can bootstrap each other's report weight, the
// clique attack one level up. Reproduces the reviewer's prove2.mjs: platformAAA (P1, id sorts
// BEFORE the target) files an upheld report directly against platformZZZ (P2, id sorts after).
// Before the fix, this reporter-sorts-first ordering let the report actually take effect (real,
// nonzero demotion), because by the time platformZZZ's report deduction ran in the stage-2 loop,
// platformAAA's sPlatform had already been computed.
test("R-3 — a platform cannot demote another platform via a report, reporter id sorting first", () => {
  const anchors = Array.from({ length: 8 }, (_, i) => `anchor${i}`);
  const accounts = [
    ...anchors.map((id) => anchorAccount(id)),
    platformAccount("platformAAA"), // reporter, sorts first
    platformAccount("platformZZZ"), // target, sorts second
  ];
  const platformVouches = [
    ...anchors.map((id) => platformVouch(id, "platformZZZ")), // 8 anchors -> s_P = 160, P2
    platformVouch("anchor0", "platformAAA"),
    platformVouch("anchor1", "platformAAA"), // 2 anchors -> s_P = 40, P1 (enough to file reports)
  ];
  const out = compute(
    makeInput({
      now: 1_000_000,
      accounts,
      platformVouches,
      reports: [
        report("r1", "platformAAA", "platformZZZ", "upheld", {
          upheldAt: 1_000_000 - 10,
          queried: true,
        }),
      ],
    }),
  );
  assert.equal(out.sPlatform["platformZZZ"], 16_000, "the forbidden report must not move the target's score");
  assert.equal(out.platformTier["platformZZZ"], 2);
  assert.equal(out.reportWeights["r1"]!.valid, false);
  assert.equal(out.reportWeights["r1"]!.voidReason, "platform_cannot_report_platform");
});

// The opposite id-sort ordering (reporter sorts AFTER the target) is the other half of the
// reviewer's proof (prove_platform_report_platform.mjs): before the fix, this ordering made the
// report look voided ONLY because platformB's own score hadn't been computed yet when
// platformA's report deduction ran (`sPlatform.get(r.reporter) ?? 0` -> weight 0) — a false
// negative that happened to look safe, not an actual voiding. Both orderings must produce the
// exact same outcome (order-independence, I-5) now that the check no longer depends on score
// lookup order at all.
test("R-3 — same result with reporter id sorting after the target (order-independence)", () => {
  const anchors = Array.from({ length: 8 }, (_, i) => `anchor${i}`);
  const accounts = [
    ...anchors.map((id) => anchorAccount(id)),
    platformAccount("platformA"), // target, sorts first
    platformAccount("platformB"), // reporter, sorts after
  ];
  const platformVouches = [
    ...anchors.map((id) => platformVouch(id, "platformA")), // 8 anchors -> s_P = 160, P2
    platformVouch("anchor0", "platformB"),
    platformVouch("anchor1", "platformB"), // 2 anchors -> s_P = 40, P1
  ];
  const out = compute(
    makeInput({
      now: 1_000_000,
      accounts,
      platformVouches,
      reports: [
        report("r1", "platformB", "platformA", "upheld", { upheldAt: 1_000_000 - 10, queried: true }),
      ],
    }),
  );
  assert.equal(out.sPlatform["platformA"], 16_000);
  assert.equal(out.platformTier["platformA"], 2);
  assert.equal(out.reportWeights["r1"]!.valid, false);
  assert.equal(out.reportWeights["r1"]!.voidReason, "platform_cannot_report_platform");
  assert.equal(out.reportWeights["r1"]!.baseWeight, 0);
  assert.equal(out.reportWeights["r1"]!.decayedWeight, 0);
});
