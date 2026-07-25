import { test } from "node:test";
import assert from "node:assert/strict";
import { compute } from "./score.js";
import { anchorAccount, human, makeInput, report, vouch } from "./test-helpers.js";

// R-1 (docs/97-review-engine-app.md; §7.1): d(r -> u) = min(snapshotWeight, score(r) * m-, cap-).
// "Both terms are required, and taking the minimum is the point... a reporter could pay for 15
// points of damage and inflict 40 after being promoted, or pay for 40 and inflict 15 after being
// demoted." Two scenarios, one per direction.

// Reporter R files at low standing (2-anchor Tier 1, s+ = 60.00, live weight = 27.50 at filing
// time, bonded that much) but is promoted to Tier 2 (s+ = 140.00, live weight would be the capped
// 40.00) by the time the graph is scored. The bonded snapshot must still cap the damage at what
// was paid for: 27.50, not 40.00.
//
// At base=20/T2=140, six anchors is the clean Tier-2 threshold for R (errata E-16; five anchors
// is only 120.00, Tier 1). The narrative "Tier 1 fresh" from the old base=10 version doesn't
// carry over cleanly: a single anchor no longer reaches T1 at all (base + cap+ = 40 < T1 = 55),
// so the illustrative low-standing weight here is simply "a 2-anchor Tier 1 account's live
// weight" rather than "the weight at the T1 threshold."
test("R-1 — a promoted reporter cannot inflict more damage than their bonded snapshot", () => {
  const reporterAnchors = ["RA1", "RA2", "RA3", "RA4", "RA5", "RA6"]; // promotes R to Tier 2 (140.00)
  const targetAnchors = ["A1", "A2"]; // target U at Tier 1 (60.00)
  const out = compute(
    makeInput({
      now: 1000,
      accounts: [
        ...reporterAnchors.map((id) => anchorAccount(id)),
        ...targetAnchors.map((id) => anchorAccount(id)),
        human("R"),
        human("U"),
      ],
      vouches: [...reporterAnchors.map((id) => vouch(id, "R")), ...targetAnchors.map((id) => vouch(id, "U"))],
      reports: [
        report("r1", "R", "U", "upheld", {
          upheldAt: 1000,
          // R bonded for 27.50 (2750 centi) worth of damage back when filing, at low standing —
          // strictly below what R's now-Tier-2 live weight (capped at 40.00) would allow.
          snapshotWeight: 2_750,
        }),
      ],
    }),
  );
  assert.equal(out.sPlus["R"], 14_000, "sanity: R is Tier 2 by the time compute() runs");
  assert.equal(out.reportWeights["r1"]!.baseWeight, 2_750, "capped at the bonded snapshot, not R's live weight (4000)");
  // U: 60.00 - 27.50 = 32.50
  assert.equal(out.score["U"], 3_250);
});

// Symmetric case: reporter bonded for the maximum (40.00) while at Tier 2, but has since been
// demoted (live weight only 20.00, from a single anchor) by the time the report is evaluated.
// Current standing must cap the damage at 20.00, not the stale, larger bond.
test("R-1 — a demoted reporter cannot inflict more damage than their current standing justifies", () => {
  const targetAnchors = ["A1", "A2", "A3", "A4", "A5", "A6"]; // target U at Tier 2 (140.00)
  const out = compute(
    makeInput({
      now: 1000,
      accounts: [
        anchorAccount("RA1"), // R's only anchor now -> s+ = 40.00, live weight 20.00
        ...targetAnchors.map((id) => anchorAccount(id)),
        human("R"),
        human("U"),
      ],
      vouches: [vouch("RA1", "R"), ...targetAnchors.map((id) => vouch(id, "U"))],
      reports: [
        report("r1", "R", "U", "upheld", {
          upheldAt: 1000,
          // R bonded for the maximum (40.00) back when they were Tier 2 / an anchor.
          snapshotWeight: 4_000,
        }),
      ],
    }),
  );
  assert.equal(out.sPlus["R"], 4_000, "sanity: R is at 40.00 now (1 anchor), live weight 20.00");
  assert.equal(out.reportWeights["r1"]!.baseWeight, 2_000, "capped at R's current live weight (20.00), not the stale 40.00 bond");
});
