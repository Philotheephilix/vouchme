import { test } from "node:test";
import assert from "node:assert/strict";
import { compute } from "./score.js";
import { anchorAccount, human, makeInput, vouch } from "./test-helpers.js";
import { MAX_ROUNDS } from "./constants.js";
import type { Account, Vouch } from "./types.js";

// When the outer origins loop is still finding new origins on the very last permitted round it
// exits via the `round < MAX_ROUNDS` test rather than the natural `newOrigins.length === 0` fixed
// point. `converged: false` is the signal for that, and the newly-admitted origins must still be
// published at depth 0.
//
// A graph that needs exactly MAX_ROUNDS (8) rounds: a chain of Tier-2 "bridge" nodes O_1..O_8,
// each vouched by 5 fixed helper anchors (H1-H5, reused for every link) plus the PREVIOUS link in
// the chain. Every O_i sits at raw BFS depth 1 from H1-H5 alone (so depth never gates the chain),
// but O_i only reaches s+ >= T2 = 140.00 once O_(i-1) has itself been promoted to depth 0 (an
// origin) — before that, O_(i-1)'s vouch is same-depth and contributes 0, leaving O_i at only
// 120.00 (5 helpers x 20.00 = 100.00 + base 20.00). O_1 instead gets a 6th real anchor (H6) so it
// can be promoted in round 0 without depending on any other chain link. This forces the loop to
// promote exactly one new origin per round, for exactly 8 rounds.
function buildChain(links: number): { accounts: Account[]; vouches: Vouch[] } {
  const helperIds = ["H1", "H2", "H3", "H4", "H5", "H6"];
  const chainIds = Array.from({ length: links }, (_, i) => `O${i + 1}`);
  const accounts: Account[] = [
    ...helperIds.map((id) => anchorAccount(id)),
    ...chainIds.map((id) => human(id)),
  ];
  const vouches: Vouch[] = [];
  for (const chainId of chainIds) {
    for (const h of ["H1", "H2", "H3", "H4", "H5"]) vouches.push(vouch(h, chainId));
  }
  vouches.push(vouch("H6", "O1")); // O1's 6th contributing voucher: a real anchor
  for (let i = 2; i <= links; i++) vouches.push(vouch(`O${i - 1}`, `O${i}`)); // O_i's 6th: O_(i-1)
  return { accounts, vouches };
}

test("R-4 — MAX_ROUNDS exhaustion is surfaced via converged:false, and depth is finalized for the last round's new origins", () => {
  // 9 links: O_1..O_8 are promoted one per round across all 8 permitted rounds (round indices
  // 0..7); O_8's promotion is only DISCOVERED on the 8th (last) iteration, so the loop exhausts
  // without a further round to re-run BFS from O_8's new depth-0 position. O_9 needs a 9th round
  // that never runs, so it must remain unpromoted — the inherent MAX_ROUNDS limit.
  const { accounts, vouches } = buildChain(9);
  const out = compute(makeInput({ now: 1000, accounts, vouches }));

  assert.equal(MAX_ROUNDS, 8, "this test is built for the documented MAX_ROUNDS=8; update the chain length if that constant changes");

  assert.equal(out.converged, false, "8 rounds each promoting exactly one new origin must exhaust MAX_ROUNDS without reaching the natural fixed point");

  // O_1..O_8 all made it into the origin set; stage 5 classifies origin membership
  // unconditionally as Tier 2.
  for (let i = 1; i <= 8; i++) {
    assert.ok(out.origins.includes(`O${i}`), `O${i} should have been promoted to an origin`);
    assert.equal(out.tier[`O${i}`], 2, `O${i} should be Tier 2`);
  }

  // O_8 was admitted to originsSet on the very last iteration; the finalization pass must still
  // publish it at depth 0, not its pre-promotion depth. Every origin is depth 0 by definition
  // (01-trust-math.md §6).
  assert.equal(out.depth["O8"], 0, "O8 is an origin and must be published at depth 0, not its stale pre-promotion depth");

  // O_9 needed a round that never ran (round index 8) to be admitted as an origin via the
  // newOrigins search — that search is deliberately NOT re-run after the finalization pass
  // (re-running it could itself loop without bound on adversarial input), so O_9 never enters
  // `origins`. This is the inherent MAX_ROUNDS limitation that `converged: false` exists to let a
  // caller detect.
  assert.ok(!out.origins.includes("O9"), "O9 needed a round that never ran and must not be an origin");
});

test("R-4 — a normal, converging graph still reports converged:true", () => {
  const out = compute(
    makeInput({
      now: 1000,
      accounts: [anchorAccount("A1"), anchorAccount("A2"), human("U")],
      vouches: [vouch("A1", "U"), vouch("A2", "U")],
    }),
  );
  assert.equal(out.converged, true);
  assert.equal(out.depth["U"], 1);
});
