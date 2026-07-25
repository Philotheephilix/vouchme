import { test } from "node:test";
import assert from "node:assert/strict";
import { compute } from "./score.js";
import { breakdown, explain } from "./explain.js";
import {
  anchorAccount,
  human,
  makeInput,
  platformAccount,
  platformVouch,
  report,
  vouch,
} from "./test-helpers.js";

// docs/99-errata.md E-2: a legal voucher (Dave, depth 3, score 36.25) whose vouch is excluded
// from Carol's (depth 2) score purely because his depth is not strictly lower than hers — the
// raw contribution (9.06) is still shown, marked not-counted, with the specific reason.
test("breakdown() — E-2: excluded voucher shows its raw contribution and the depth reason", () => {
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
    human("Carol"), // depth 2
    human("D2b"),
    human("D2c"),
    human("Dave"), // depth 3
  ];
  const d2 = ["Carol", "D2b", "D2c"];
  const vouches = [
    vouch("A1", "D1a"),
    vouch("A2", "D1a"),
    vouch("A3", "D1b"),
    vouch("A4", "D1b"),
    vouch("A5", "D1c"),
    vouch("A6", "D1c"),
    // every d2 node (Carol, D2b, D2c) vouched by exactly 2 distinct d1 nodes => 35.00 each
    vouch("D1a", "Carol"),
    vouch("D1b", "Carol"),
    vouch("D1b", "D2b"),
    vouch("D1c", "D2b"),
    vouch("D1a", "D2c"),
    vouch("D1c", "D2c"),
    ...d2.map((id) => vouch(id, "Dave")),
    // the excluded edge: Dave (depth 3) vouches for Carol (depth 2)
    vouch("Dave", "Carol"),
  ];
  const input = makeInput({ accounts, vouches });
  const out = compute(input);

  assert.equal(out.sPlus["Carol"], 3_500); // unaffected by Dave's vouch
  assert.equal(out.sPlus["Dave"], 3_625);

  const bd = breakdown("Carol", input, out);
  const daveRow = bd.vouchers.find((v) => v.voucher === "Dave");
  assert.ok(daveRow);
  assert.equal(daveRow!.counted, false);
  assert.equal(daveRow!.reason, "voucher_depth_not_lower");
  assert.equal(daveRow!.rawContribution, 906); // trunc(36.25 * 0.25 * 100) = 906 (9.06)
  assert.equal(daveRow!.contribution, 0);

  // and Carol's 2 real d1 vouchers ARE counted
  const countedVouchers = bd.vouchers.filter((v) => v.counted).map((v) => v.voucher);
  assert.deepEqual(countedVouchers.sort(), ["D1a", "D1b"]);
});

test("breakdown() — inactive and non-human vouches are rows too, with reasons, contributing 0", () => {
  const accounts = [anchorAccount("A1"), human("U"), platformAccount("P")];
  const input = makeInput({
    accounts,
    vouches: [
      vouch("A1", "U"),
      { voucher: "ghost", vouchee: "U", active: false }, // inactive
      { voucher: "P", vouchee: "U", active: true }, // platform pretending to vouch (I-16)
    ],
  });
  const out = compute(input);
  const bd = breakdown("U", input, out);

  const inactive = bd.vouchers.find((v) => v.voucher === "ghost");
  assert.equal(inactive!.counted, false);
  assert.equal(inactive!.reason, "vouch_inactive");

  const fromPlatform = bd.vouchers.find((v) => v.voucher === "P");
  assert.equal(fromPlatform!.counted, false);
  assert.equal(fromPlatform!.reason, "voucher_not_human");

  const real = bd.vouchers.find((v) => v.voucher === "A1");
  assert.equal(real!.counted, true);
});

test("breakdown() — an anchor's inbound vouches are all excluded (E-6: anchors ignore inbound)", () => {
  const accounts = [anchorAccount("A1"), anchorAccount("A2"), human("U")];
  const input = makeInput({ accounts, vouches: [vouch("U", "A2"), vouch("A1", "U")] });
  const out = compute(input);
  const bd = breakdown("A2", input, out);
  assert.equal(bd.vouchers.length, 1);
  assert.equal(bd.vouchers[0]!.counted, false);
  assert.equal(bd.vouchers[0]!.reason, "anchor_ignores_inbound");
  assert.equal(out.sPlus["A2"], 10_000);
});

test("explain() — produces a non-empty, deterministic prose string for a human and a platform", () => {
  const input = makeInput({
    now: 0,
    accounts: [
      anchorAccount("A1"),
      anchorAccount("A2"),
      human("U"),
      anchorAccount("A3"),
      platformAccount("P"),
    ],
    vouches: [vouch("A1", "U"), vouch("A2", "U")],
    platformVouches: [platformVouch("A1", "P"), platformVouch("A2", "P")],
    reports: [report("r1", "A3", "U", "upheld", { upheldAt: 0 })],
  });
  const out = compute(input);

  const humanText = explain("U", out);
  assert.ok(humanText.length > 0);
  assert.ok(humanText.includes("Tier"));
  assert.equal(explain("U", out), humanText, "explain() must be deterministic");

  const platformText = explain("P", out);
  assert.ok(platformText.length > 0);
  assert.ok(platformText.includes("platform"));
});
