import { test } from "node:test";
import assert from "node:assert/strict";
import { compute } from "./score.js";
import { anchorAccount, human, makeInput, report, vouch } from "./test-helpers.js";

// R-1 (docs/97-review-engine-app.md; §7.1): d(r -> u) = min(snapshotWeight, score(r) * m-, cap-).
// "Both terms are required, and taking the minimum is the point... a reporter could pay for 15
// points of damage and inflict 40 after being promoted, or pay for 40 and inflict 15 after being
// demoted." Two scenarios, one per direction.

// Reporter R files at low standing (Tier 1 fresh, s+ = 30.00, live weight = 15.00 at filing time,
// bonded 10x that) but is promoted to Tier 2 (s+ = 110.00, live weight would be the capped 40.00)
// by the time the graph is scored. The bonded snapshot must still cap the damage at what was paid
// for: 15.00, not 40.00.
test("R-1 — a promoted reporter cannot inflict more damage than their bonded snapshot", () => {
  const reporterAnchors = ["RA1", "RA2", "RA3", "RA4", "RA5"]; // promotes R to Tier 2 (110.00)
  const targetAnchors = ["A1", "A2"]; // target U at Tier 1 (50.00)
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
          // R bonded for 15.00 (1500 centi) worth of damage back when filing, at Tier 1 fresh.
          snapshotWeight: 1_500,
        }),
      ],
    }),
  );
  assert.equal(out.sPlus["R"], 11_000, "sanity: R is Tier 2 by the time compute() runs");
  assert.equal(out.reportWeights["r1"]!.baseWeight, 1_500, "capped at the bonded snapshot, not R's live weight (4000)");
  // U: 50.00 - 15.00 = 35.00
  assert.equal(out.score["U"], 3_500);
});

// Symmetric case: reporter bonded for the maximum (40.00) while at Tier 2, but has since been
// demoted to Tier 1 fresh (live weight 15.00) by the time the report is evaluated. Current
// standing must cap the damage at 15.00, not the stale, larger bond.
test("R-1 — a demoted reporter cannot inflict more damage than their current standing justifies", () => {
  const targetAnchors = ["A1", "A2", "A3", "A4", "A5"]; // target U at Tier 2 (110.00)
  const out = compute(
    makeInput({
      now: 1000,
      accounts: [
        anchorAccount("RA1"), // R's only anchor now -> s+ = 30.00 (Tier 1 fresh), live weight 15.00
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
  assert.equal(out.sPlus["R"], 3_000, "sanity: R is Tier 1 fresh now (1 anchor), live weight 15.00");
  assert.equal(out.reportWeights["r1"]!.baseWeight, 1_500, "capped at R's current live weight (15.00), not the stale 40.00 bond");
});
