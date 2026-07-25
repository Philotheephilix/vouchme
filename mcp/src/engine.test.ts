// @aval/mcp — src/engine.test.ts
//
// Smoke tests for the local scoring re-implementation (docs/01-trust-math.md
// §15) against docs/10-constants.md §8's worked examples. Run with `npm
// test` after `npm run build`.

import assert from "node:assert/strict";
import { test } from "node:test";
import { BASE, deriveBreakdown, scoreGraph, T1, type TrustGraph } from "./engine.js";

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

test("two anchor vouches give score 50 (docs/10 §8: 'Score with 2 anchors')", () => {
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
  assert.equal(carol.score, 50);
  assert.equal(carol.tier, 1);
  assert.ok(carol.score >= T1);
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
  const scored = scoreGraph(g);
  const { breakdown } = deriveBreakdown("0xcarol", g, scored, (a) => a);
  const daveRow = breakdown.find((r) => r.voucher === "0xdave")!;
  assert.equal(daveRow.counted, false);
  assert.equal(daveRow.reason, "voucher_depth_not_lower");
  assert.equal(daveRow.contribution, 0);
});
