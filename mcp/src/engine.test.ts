// @aval/mcp — src/engine.test.ts
//
// Smoke tests for scoreGraph()/deriveBreakdown() (engine.ts's thin wrapper over the real
// @aval/engine compute()/breakdown() — see that file's module comment). Assertions below compute
// their expected values from the live BASE/CAP_POS/M_POS/T1 constants imported from engine.ts
// (themselves derived from @aval/engine, never hardcoded) rather than pinning literals, precisely
// because docs/10-constants.md's thresholds are expected to change during this task (task brief:
// "if your assertions suddenly shift, that is why; re-read the engine's constants rather than
// pinning numbers") — and they did: BASE/T1/T2 moved from 10/30/100 to 20/55/140 partway through
// this build. Run with `npm test` after `npm run build`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, CAP_POS, M_POS, computeEngine, deriveBreakdown, scoreGraph, T1, type TrustGraph } from "./engine.js";

function graph(accounts: TrustGraph["accounts"], vouches: TrustGraph["vouches"]): TrustGraph {
  return { accounts, vouches, meta: { deploymentId: "Qm-test", blockNumber: 1 } };
}

function account(id: string, isAnchor = false): TrustGraph["accounts"][number] {
  return {
    id,
    handle: id,
    isAnchor,
    status: "ACTIVE",
    credential: "selfie-check",
    credentialExpiresAt: 9_999_999_999n,
    activeOutboundCount: 0,
  };
}

test("an unreached account scores exactly BASE (docs/10 §8: clique scores exactly BASE)", () => {
  const g = graph([account("0xa"), account("0xb")], []);
  const scored = scoreGraph(g);
  assert.equal(scored.scores.get("0xa")?.score, BASE);
  assert.equal(scored.scores.get("0xa")?.tier, 0);
});

test("two anchor vouches give score BASE + 2x(capped anchor contribution) (docs/10 §8: 'Score with 2 anchors')", () => {
  const now = 1_700_000_000n;
  const g = graph(
    [account("0xanchor1", true), account("0xanchor2", true), account("0xcarol")],
    [
      { voucherId: "0xanchor1", voucheeId: "0xcarol", issuedAt: now, expiresAt: now + 1000n },
      { voucherId: "0xanchor2", voucheeId: "0xcarol", issuedAt: now, expiresAt: now + 1000n },
    ],
  );
  const scored = scoreGraph(g);
  const carol = scored.scores.get("0xcarol")!;
  // Anchor score is fixed at 100.00 (ANCHOR, 01-trust-math.md §2); each anchor's contribution is
  // min(100 x M_POS, CAP_POS) — CAP_POS binds here (100 x 0.25 = 25 > CAP_POS), so it's exactly
  // CAP_POS per anchor, not a re-derivation of the multiplier math, just applying the same
  // min()-cap @aval/engine's own weightPos() uses.
  const perAnchorContribution = Math.min(100 * M_POS, CAP_POS);
  assert.equal(carol.score, BASE + 2 * perAnchorContribution);
  assert.equal(carol.tier, carol.score >= T1 ? 1 : 0);
  assert.ok(carol.score >= T1, `expected two-anchor score ${carol.score} to reach T1 (${T1}) — if not, this graph needs a third anchor under the current constants`);
});

test("a depth-3 voucher does not count toward a depth-2 account (anti-collusion ordering)", () => {
  const now = 1_700_000_000n;
  const g = graph(
    [account("0xanchor", true), account("0xalice"), account("0xcarol"), account("0xdave")],
    [
      { voucherId: "0xanchor", voucheeId: "0xalice", issuedAt: now, expiresAt: now + 1000n }, // alice depth 1
      { voucherId: "0xalice", voucheeId: "0xcarol", issuedAt: now, expiresAt: now + 1000n }, // carol depth 2
      { voucherId: "0xalice", voucheeId: "0xdave", issuedAt: now, expiresAt: now + 1000n }, // dave depth 2 too
      { voucherId: "0xdave", voucheeId: "0xcarol", issuedAt: now, expiresAt: now + 1000n }, // dave (depth 2) -> carol (depth 2): not lower, excluded
    ],
  );
  const engineIO = computeEngine(g, now);
  const { breakdown } = deriveBreakdown("0xcarol", g, engineIO, (a) => a);
  const daveRow = breakdown.find((r) => r.voucher === "0xdave")!;
  assert.equal(daveRow.counted, false);
  assert.equal(daveRow.reason, "voucher_depth_not_lower");
  assert.equal(daveRow.contribution, 0);
});
