import { test } from "node:test";
import assert from "node:assert/strict";
import { compute } from "./score.js";
import { anchorAccount, human, makeInput, report, vouch } from "./test-helpers.js";

// R-6 (docs/97-review-engine-app.md): a NaN/Infinity/non-integer `now` or `report.upheldAt` must
// fail loudly (RangeError), not propagate silently into decay/gate-4-window arithmetic and taint
// the output with NaN — matching `tenureCenti`'s own guard on its input (tenure.ts).

test("R-6 — compute() rejects a non-finite `now`", () => {
  assert.throws(
    () => compute(makeInput({ now: Number.NaN, accounts: [human("U")] })),
    RangeError,
  );
  assert.throws(
    () => compute(makeInput({ now: Number.POSITIVE_INFINITY, accounts: [human("U")] })),
    RangeError,
  );
  assert.throws(
    () => compute(makeInput({ now: Number.NEGATIVE_INFINITY, accounts: [human("U")] })),
    RangeError,
  );
});

test("R-6 — compute() rejects a non-integer `now`", () => {
  assert.throws(() => compute(makeInput({ now: 1234.5, accounts: [human("U")] })), RangeError);
});

test("R-6 — compute() rejects a non-finite or non-integer report.upheldAt", () => {
  const scenario = (upheldAt: number) =>
    makeInput({
      now: 1000,
      accounts: [anchorAccount("A1"), anchorAccount("A2"), human("U")],
      vouches: [vouch("A1", "U"), vouch("A2", "U")],
      reports: [report("r1", "A1", "U", "upheld", { upheldAt })],
    });

  assert.throws(() => compute(scenario(Number.NaN)), RangeError);
  assert.throws(() => compute(scenario(Number.POSITIVE_INFINITY)), RangeError);
  assert.throws(() => compute(scenario(500.5)), RangeError);
});

test("R-6 — a valid, finite integer now/upheldAt still computes normally", () => {
  const out = compute(
    makeInput({
      now: 1000,
      accounts: [anchorAccount("A1"), anchorAccount("A2"), human("U")],
      vouches: [vouch("A1", "U"), vouch("A2", "U")],
      reports: [report("r1", "A1", "U", "upheld", { upheldAt: 500 })],
    }),
  );
  assert.equal(out.sPlus["U"], 5_000);
});
