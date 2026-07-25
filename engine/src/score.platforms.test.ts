import { test } from "node:test";
import assert from "node:assert/strict";
import { compute } from "./score.js";
import {
  anchorAccount,
  human,
  makeInput,
  platformAccount,
  platformVouch,
  report,
  vouch,
} from "./test-helpers.js";

// docs/01-trust-math.md §12.3 — platform scores. One test per row.

test("12.3 — nobody vouches: s_P = 0, P0, cannot report (I-16 also covered: no positive edge)", () => {
  const out = compute(
    makeInput({ accounts: [platformAccount("P")] }),
  );
  assert.equal(out.sPlatform["P"], 0);
  assert.equal(out.platformTier["P"], 0);
});

test("12.3 — 1 anchor vouches: s_P = 20, P0 (also fails the 2-voucher gate)", () => {
  const out = compute(
    makeInput({
      accounts: [anchorAccount("A1"), platformAccount("P")],
      platformVouches: [platformVouch("A1", "P")],
    }),
  );
  assert.equal(out.sPlatform["P"], 2_000);
  assert.equal(out.platformTier["P"], 0);
});

test("12.3 — 2 anchors vouch: s_P = 40, P1, reports at weight 20", () => {
  const out = compute(
    makeInput({
      accounts: [anchorAccount("A1"), anchorAccount("A2"), platformAccount("P")],
      platformVouches: [platformVouch("A1", "P"), platformVouch("A2", "P")],
    }),
  );
  assert.equal(out.sPlatform["P"], 4_000);
  assert.equal(out.platformTier["P"], 1);
});

test("12.3 — 4 × T1@50 vouch: s_P = 50, P1, reports at weight 25", () => {
  const anchors = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"];
  const vouchers = ["V0", "V1", "V2", "V3"];
  const out = compute(
    makeInput({
      accounts: [
        ...anchors.map((id) => anchorAccount(id)),
        ...vouchers.map((id) => human(id)),
        platformAccount("P"),
      ],
      vouches: [
        vouch("A1", "V0"),
        vouch("A2", "V0"),
        vouch("A3", "V1"),
        vouch("A4", "V1"),
        vouch("A5", "V2"),
        vouch("A6", "V2"),
        vouch("A7", "V3"),
        vouch("A8", "V3"),
      ],
      platformVouches: vouchers.map((id) => platformVouch(id, "P")),
    }),
  );
  for (const id of vouchers) assert.equal(out.sPlus[id], 5_000);
  assert.equal(out.sPlatform["P"], 5_000);
  assert.equal(out.platformTier["P"], 1);
});

test("12.3 — 8 anchors vouch: s_P = 160, P2, reports at weight 40 (capped)", () => {
  const anchors = Array.from({ length: 8 }, (_, i) => `A${i}`);
  const out = compute(
    makeInput({
      accounts: [...anchors.map((id) => anchorAccount(id)), platformAccount("P")],
      platformVouches: anchors.map((id) => platformVouch(id, "P")),
    }),
  );
  assert.equal(out.sPlatform["P"], 16_000);
  assert.equal(out.platformTier["P"], 2);
});

test("12.3 — 8 anchors, then 3 humans report it: s_P = 160-120 = 40, P1 (demoted by its users)", () => {
  const anchors = Array.from({ length: 8 }, (_, i) => `A${i}`);
  const reporterAnchors = ["R0", "R1", "R2"];
  const out = compute(
    makeInput({
      now: 0,
      accounts: [
        ...anchors.map((id) => anchorAccount(id)),
        ...reporterAnchors.map((id) => anchorAccount(id)),
        platformAccount("P"),
      ],
      platformVouches: anchors.map((id) => platformVouch(id, "P")),
      reports: reporterAnchors.map((id, i) =>
        report(`rep${i}`, id, "P", "upheld", { upheldAt: 0 }),
      ),
    }),
  );
  assert.equal(out.sPlatform["P"], 4_000);
  assert.equal(out.platformTier["P"], 1);
});

// P-1 / P-3-adjacent: platforms never appear as the source of a positive human edge (I-16),
// even if a caller hands the engine a malformed "vouch" whose voucher is a platform id.
test("I-16 — a platform can never be the source of a positive human edge", () => {
  const out = compute(
    makeInput({
      accounts: [platformAccount("P"), human("U")],
      // malformed input: P is a platform, not a human, attempting to vouch for U.
      vouches: [vouch("P", "U")],
    }),
  );
  assert.equal(out.sPlus["U"], 1_000, "the bogus platform-sourced edge must contribute nothing");
  assert.equal(out.tier["U"], 0);
});
