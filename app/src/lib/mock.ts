/**
 * THE ONLY PLACE NUMBERS COME FROM.
 *
 * Every score, weight, countdown and stamp rendered anywhere in this app is exported from this
 * file (or derived from something exported here via src/lib/format.ts). Nothing is typed directly
 * into JSX.
 *
 * R-8 (docs/97-review-engine-app.md): this file used to carry its own hand-written port of the
 * stage-1 (positive score) algorithm, and that port reimplemented (and got wrong) gate 2 — it
 * counted raw inbound edges instead of *contributing* vouchers, so
 * `EXPLORE_RING.gates.g2TwoDistinctVouchers` came out `true` when docs/01-trust-math.md §12.1's
 * own worked table says `false` for exactly this six-account ring. The fix is not to patch that
 * port; it is to delete it. Below, this file supplies only the GRAPH — accounts, vouches,
 * platform vouches, reports — in `@aval/engine`'s own input shape, and calls the real `compute()`
 * / `breakdown()` for every score, tier, depth, and per-edge contribution. That is the only way
 * the UI can't drift from the protocol: one scoring implementation, used everywhere. A few display
 * fields genuinely have no engine equivalent (edge timestamps, slot bookkeeping, bond amounts) —
 * those are called out with a comment at the point they're derived.
 */

import {
  BASE,
  CAP_NEG,
  GATE4_WINDOW_DAYS,
  MAX_DEPTH,
  MIN_VOUCHERS,
  M_POS_DEN,
  M_POS_NUM,
  P1,
  SECONDS_PER_DAY,
  T1,
  breakdown,
  compute,
} from "@aval/engine";
import type { Account, EngineInput, EngineOutput, PlatformVouch, Report, Vouch } from "@aval/engine";
import type {
  AccountKind,
  AgentRecord,
  ApiMeta,
  CandidateVoucher,
  ExploreScenario,
  Gates,
  GatePolicy,
  GateResult,
  IdentityResult,
  HealthResult,
  PathResult,
  PlatformScoreResult,
  PresenceState,
  ReportEntry,
  ReportStatus,
  ScoreResult,
  SimulateVouchResult,
  SimulateVouchStep,
  Slots,
  Tier,
  VouchContribution,
  VoucherSummary,
} from "./types";
import { centiToScore, tenureCurve, tenureFromDays } from "./format";

// ─── the "now" the whole fixture is dated relative to ───────────────────────────────────────────

export const NOW = new Date("2026-07-25T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (daysFromNow: number): string => new Date(NOW.getTime() + daysFromNow * DAY_MS).toISOString();
/** The engine works in unix seconds, supplied by the caller (@aval/engine never reads a clock). */
const GRAPH_NOW = Math.floor(NOW.getTime() / 1000);

/** m+ = 0.25, for the "50.0 x 0.25" display line — imported from the engine's own constants
 *  rather than a hardcoded 0.25, so this can't drift from the real multiplier either. */
const DISPLAY_M_POS = M_POS_NUM / M_POS_DEN;

// ─── the fixture graph, in @aval/engine's own input shape ───────────────────────────────────────
//
//   anchor1, anchor2          Orb-verified, depth 0
//   alice, bob, henry, iris   each vouched by both anchors -> 50.00, Tier 1, depth 1
//                              (docs/01-trust-math.md §12.1 "2 anchors" row). henry and iris are
//                              real, engine-scored Tier-1-mid accounts that the candidates/platform
//                              fixtures below point at, instead of a hand-typed score constant.
//   carol.alice.aval.eth     "ME" — vouched by alice AND bob -> 35.00, Tier 1, depth 2
//                              (§12.1 "2 x T1 @ 50" row; docs/07-app-api.md §2.2's worked example)
//   dave.carol.aval.eth      vouched by carol only (depth 3, 18.75, Tier 0) — and vouches carol
//                              BACK. That reciprocal edge is the zero-contribution row: dave's depth
//                              (3) is not strictly lower than carol's (2), so it contributes +0.0.
//   erin.carol.aval.eth      vouched by carol only (depth 3, 18.75, Tier 0) — carol's 2nd used
//                              slot, used in the vouch-simulation secondary-effect fixture.
//   grace.bob.aval.eth       vouched by bob only (depth 2, 22.50) — a Vouch-candidate example.
//   ring1..ring6               fully mutual (K6) clique, zero path to any anchor
//                              (§12.1 "6-account mutual ring" row: 10.00, Tier 0, blocked x3 under
//                              the corrected gate 2 — this exact scenario is what R-8 was about)

const ME_ID = "carol.alice.aval.eth";
const HENRY_ID = "henry.aval.eth";
const IRIS_ID = "iris.aval.eth";
const PLATFORM_ID = "marketpulse.aval.eth";

const RING_IDS = ["ring1.eth", "ring2.eth", "ring3.eth", "ring4.eth", "ring5.eth", "ring6.eth"];

const ACCOUNTS: Account[] = [
  { id: "anchor1.aval.eth", kind: "human", isAnchor: true },
  { id: "anchor2.aval.eth", kind: "human", isAnchor: true },
  { id: "alice.aval.eth", kind: "human" },
  { id: "bob.aval.eth", kind: "human" },
  { id: HENRY_ID, kind: "human" },
  { id: IRIS_ID, kind: "human" },
  { id: ME_ID, kind: "human" },
  { id: "dave.carol.aval.eth", kind: "human" },
  { id: "erin.carol.aval.eth", kind: "human" },
  { id: "grace.bob.aval.eth", kind: "human" },
  // docs/04-ens.md §1.2: names like this "resolve to nothing, because none of those labels descend
  // from aval.eth" — the ring is unrepresentable in the real namespace. Kept as flat mock ids here
  // only so the fixture graph has six distinct, clearly-labelled ring accounts to compute over.
  ...RING_IDS.map((id): Account => ({ id, kind: "human" })),
  { id: PLATFORM_ID, kind: "platform" },
];

function mkVouch(voucher: string, vouchee: string): Vouch {
  return { voucher, vouchee, active: true };
}

const CORE_VOUCHES: Vouch[] = [
  mkVouch("anchor1.aval.eth", "alice.aval.eth"),
  mkVouch("anchor2.aval.eth", "alice.aval.eth"),
  mkVouch("anchor1.aval.eth", "bob.aval.eth"),
  mkVouch("anchor2.aval.eth", "bob.aval.eth"),
  mkVouch("anchor1.aval.eth", HENRY_ID),
  mkVouch("anchor2.aval.eth", HENRY_ID),
  mkVouch("anchor1.aval.eth", IRIS_ID),
  mkVouch("anchor2.aval.eth", IRIS_ID),
  mkVouch("alice.aval.eth", ME_ID),
  mkVouch("bob.aval.eth", ME_ID),
  mkVouch(ME_ID, "dave.carol.aval.eth"),
  mkVouch("dave.carol.aval.eth", ME_ID), // reciprocal — zero-contribution row
  mkVouch(ME_ID, "erin.carol.aval.eth"),
  mkVouch("bob.aval.eth", "grace.bob.aval.eth"),
];

const RING_VOUCHES: Vouch[] = RING_IDS.flatMap((src) =>
  RING_IDS.filter((dst) => dst !== src).map((dst) => mkVouch(src, dst)),
);

const ALL_VOUCHES: Vouch[] = [...CORE_VOUCHES, ...RING_VOUCHES];

const PLATFORM_VOUCHES: PlatformVouch[] = ["alice.aval.eth", "bob.aval.eth", HENRY_ID, IRIS_ID].map(
  (voucher): PlatformVouch => ({ voucher, platform: PLATFORM_ID, active: true }),
);

const OLD_UPHELD_AGO_DAYS = 185; // past the 180-day decay window (docs/01-trust-math.md §7.4)

// docs/12-reporting.md §3, docs/01-trust-math.md §7 — real reports fed through the real engine, so
// weight/decay/void-reason are computed the same way a live report would be, not approximated by a
// standalone formula. `snapshotWeight: CAP_NEG` for all three: none of these illustrative reports
// are meant to demonstrate the R-1 bonded-snapshot cap itself (that's covered by the engine's own
// tests), so the snapshot is set to the max, making weight = min(live, cap) exactly as it would be
// for an ordinary report that hasn't hit its bond ceiling.
const GRAPH_REPORTS: Report[] = [
  {
    id: "rpt_pending_henry",
    reporter: HENRY_ID,
    target: ME_ID,
    state: "pending",
    snapshotWeight: CAP_NEG,
  },
  {
    id: "rpt_decayed_anchor2",
    reporter: "anchor2.aval.eth",
    target: ME_ID,
    state: "upheld",
    upheldAt: GRAPH_NOW - OLD_UPHELD_AGO_DAYS * SECONDS_PER_DAY,
    snapshotWeight: CAP_NEG,
  },
  {
    id: "rpt_upheld_filed_by_me",
    reporter: ME_ID,
    target: RING_IDS[0]!,
    state: "upheld",
    upheldAt: GRAPH_NOW - 45 * SECONDS_PER_DAY,
    snapshotWeight: CAP_NEG,
  },
];

const ENGINE_INPUT: EngineInput = {
  now: GRAPH_NOW,
  accounts: ACCOUNTS,
  vouches: ALL_VOUCHES,
  platformVouches: PLATFORM_VOUCHES,
  reports: GRAPH_REPORTS,
};

const RESULT: EngineOutput = compute(ENGINE_INPUT);

// Same graph, minus bob -> carol, for the weakest-link / vouch-simulation fixtures.
const VOUCHES_WITHOUT_BOB: Vouch[] = ALL_VOUCHES.filter(
  (v) => !(v.voucher === "bob.aval.eth" && v.vouchee === ME_ID),
);
const RESULT_WITHOUT_BOB: EngineOutput = compute({ ...ENGINE_INPUT, vouches: VOUCHES_WITHOUT_BOB });

// ─── small helpers over the two computed results ─────────────────────────────────────────────────

function humanScore(id: string): number {
  return centiToScore(RESULT.score[id] ?? BASE);
}
function humanSPlus(id: string): number {
  return centiToScore(RESULT.sPlus[id] ?? BASE);
}
function humanScoreAtRisk(id: string): number {
  return centiToScore(RESULT.scoreAtRisk[id] ?? BASE);
}
function depthOf(id: string): number | null {
  const d = RESULT.depth[id];
  return d !== undefined && Number.isFinite(d) ? d : null;
}
function tierOf(id: string): Tier {
  return (RESULT.tier[id] ?? 0) as Tier;
}
function platformTierFromEngine(t: number | undefined): "P0" | "P1" | "P2" {
  return (t ?? 0) >= 2 ? "P2" : (t ?? 0) >= 1 ? "P1" : "P0";
}

const breakdownCache = new Map<string, ReturnType<typeof breakdown>>();
function breakdownFor(id: string): ReturnType<typeof breakdown> {
  let bd = breakdownCache.get(id);
  if (!bd) {
    bd = breakdown(id, ENGINE_INPUT, RESULT);
    breakdownCache.set(id, bd);
  }
  return bd;
}

/** No engine-exposed equivalent: `EngineOutput` publishes tiers, not the individual gate booleans
 *  that fed them (docs/01-trust-math.md §11). Mirrors the engine's own internal check purely over
 *  already-public data (`GRAPH_REPORTS` + `GRAPH_NOW`), for display only — it does not influence
 *  any score or tier, which the real engine already computed correctly. */
function hasRecentUpheldReportAgainst(id: string): boolean {
  return GRAPH_REPORTS.some(
    (r) =>
      r.target === id &&
      r.state === "upheld" &&
      r.upheldAt !== undefined &&
      GRAPH_NOW - r.upheldAt < GATE4_WINDOW_DAYS * SECONDS_PER_DAY &&
      GRAPH_NOW - r.upheldAt >= 0,
  );
}

/** Gate 2 here is derived from `breakdown()`'s own `counted` flag — the exact same corrected,
 *  depth-ordered definition the real engine's gate 2 uses (R-8) — not re-counted independently. */
function gatesFor(id: string): Gates {
  const bd = breakdownFor(id);
  const distinctCounted = new Set(bd.vouchers.filter((v) => v.counted).map((v) => v.voucher)).size;
  const d = RESULT.depth[id];
  const scoreCenti = RESULT.score[id] ?? BASE;
  return {
    g1ScoreThreshold: scoreCenti >= T1,
    g2TwoDistinctVouchers: distinctCounted >= MIN_VOUCHERS,
    g3PathToOrigin: d !== undefined && Number.isFinite(d) && d <= MAX_DEPTH,
    g4NoRecentUpheldReport: !hasRecentUpheldReportAgainst(id),
  };
}

function voucherSummary(id: string): VoucherSummary {
  const acc = ACCOUNTS.find((a) => a.id === id);
  return {
    address: addressFor(id),
    ensName: id,
    score: humanScore(id),
    tier: tierOf(id),
    depth: depthOf(id),
    isAnchor: acc?.isAnchor ?? false,
  };
}

/** Deterministic fake address so every fixture identity has one, without a real keystore. */
function addressFor(ensName: string): `0x${string}` {
  let h = 0;
  for (let i = 0; i < ensName.length; i++) h = (h * 31 + ensName.charCodeAt(i)) >>> 0;
  const hex = h.toString(16).padStart(8, "0");
  return `0x${hex.repeat(5).slice(0, 40)}`;
}

function displayLabel(ensName: string): string {
  const [first] = ensName.split(".");
  return first ? first[0]!.toUpperCase() + first.slice(1) : ensName;
}

type EngineVoucherRow = ReturnType<typeof breakdown>["vouchers"][number];

/** Plain-language reason for a zero-contribution row, from the engine's own machine-readable
 *  reason code (docs/01-trust-math.md's own E-2 errata example: the zero-contribution rows are
 *  required UI, not decoration). */
function voucherReasonText(row: EngineVoucherRow): string | null {
  if (row.counted) return null;
  switch (row.reason) {
    case "anchor_ignores_inbound":
      return "anchors ignore every inbound vouch — their score is fixed.";
    case "vouch_inactive":
      return "this vouch has expired or been revoked.";
    case "voucher_not_human":
      return "the source of this vouch is not a human account.";
    case "voucher_unreachable":
      return `${displayLabel(row.voucher)} has no path from any anchor, so it doesn't count.`;
    case "voucher_depth_not_lower":
      return (
        `${displayLabel(row.voucher)} is at depth ${row.voucherDepth ?? "∞"}, which is not lower ` +
        `than yours, so it doesn't count.`
      );
    default:
      return null;
  }
}

/** issuedAt/expiresAt/daysUntilExpiry/expiringSoon have NO engine equivalent — `Vouch` only
 *  carries a caller-resolved `active` boolean (see @aval/engine's own doc comment on that field),
 *  never timestamps. This is exactly the "no engine equivalent" case R-8's own fix instructions
 *  call out: derived here, deterministically, from fixture-authored edge metadata, everything else
 *  on the row taken straight from the engine's `breakdown()`. */
function contributionRowFromEngine(
  row: EngineVoucherRow,
  edge: { issuedAgoDays: number; expiresInDays: number },
): VouchContribution {
  return {
    voucher: voucherSummary(row.voucher),
    weight: DISPLAY_M_POS,
    contribution: centiToScore(row.contribution),
    counted: row.counted,
    reason: voucherReasonText(row),
    issuedAt: iso(-edge.issuedAgoDays),
    expiresAt: iso(edge.expiresInDays),
    daysUntilExpiry: edge.expiresInDays,
    expiringSoon: edge.expiresInDays <= 21,
  };
}

// ─── meta envelope — docs/07-app-api.md §3, carried on every response ───────────────────────────

export const MOCK_META: ApiMeta = {
  subgraphDeployment: "QmXoT9auAvEZuwVUXCoAxzuUxKG1nGbXCn6UhtqrBQqLA5",
  computedAtBlock: 8_214_552,
  indexerLagBlocks: 2,
  engineVersion: "0.1.0",
};

/** Score 10, tier 0 — what enrollment alone buys you (docs/07-app-api.md §2.1). */
export const ENROLLMENT_BASE_SCORE = centiToScore(BASE);

export const HEALTH: HealthResult = {
  status: MOCK_META.indexerLagBlocks <= 50 ? "ok" : "degraded",
  subgraphDeployment: MOCK_META.subgraphDeployment,
  indexedBlock: MOCK_META.computedAtBlock,
  chainHead: MOCK_META.computedAtBlock + MOCK_META.indexerLagBlocks,
  lagBlocks: MOCK_META.indexerLagBlocks,
};

// ─── carol.alice.aval.eth — "you", the primary demo identity ────────────────────────────────────

const ME_BD = breakdownFor(ME_ID);
function meRow(voucherId: string, edge: { issuedAgoDays: number; expiresInDays: number }): VouchContribution {
  const row = ME_BD.vouchers.find((v) => v.voucher === voucherId);
  if (!row) throw new Error(`mock.ts: no breakdown row for voucher "${voucherId}" -> "${ME_ID}"`);
  return contributionRowFromEngine(row, edge);
}

const ME_BREAKDOWN: VouchContribution[] = [
  meRow("alice.aval.eth", { issuedAgoDays: 16, expiresInDays: 74 }),
  meRow("bob.aval.eth", { issuedAgoDays: 72, expiresInDays: 18 }),
  meRow("dave.carol.aval.eth", { issuedAgoDays: 5, expiresInDays: 85 }),
];

const ME_SLOTS: Slots = { total: 3, used: 2, free: 1 }; // no engine equivalent — carol vouched for
// dave + erin; slot usage bookkeeping is a contract/indexer ledger, not part of scoring.

const meScoreIfBobExpires = centiToScore(RESULT_WITHOUT_BOB.score[ME_ID] ?? BASE);
const meTierIfBobExpires = (RESULT_WITHOUT_BOB.tier[ME_ID] ?? 0) as Tier;

// docs/16-presence-drip.md §9 — an independent illustrative panel. Carol's own `tenure` field below
// is 0.00 so that the Home arithmetic line reads exactly "base 10.0 + 25.0 = 35.0"
// (docs/07-app-api.md §2.2); the drip/tenure panel demonstrates the *mechanism* using the real
// engine's tenureCenti (via src/lib/format.ts `tenureFromDays`, R-7) rather than feeding back into
// this fixture's score.
const ME_PRESENT_DAYS = 214;
const ME_ACCRUED_AVAL = 14.5;
const ME_DAILY_RATE = 1.0; // Tier 1 => 100% of drip_nominal (docs/16-presence-drip.md §3)
const ME_PRESENCE: PresenceState = {
  dailyRateAval: ME_DAILY_RATE,
  accruedAval: ME_ACCRUED_AVAL,
  maxUnclaimedDays: 30,
  daysUntilCap: 30 - ME_ACCRUED_AVAL / ME_DAILY_RATE,
  presentDays: ME_PRESENT_DAYS,
  tenureBonus: tenureFromDays(ME_PRESENT_DAYS),
  tenureMaxBonus: 5.0,
  tierRatePct: 100,
  curve: tenureCurve(720, 72),
};

export const ME: ScoreResult = {
  address: addressFor(ME_ID),
  ensName: ME_ID,
  kind: "member",
  base: 10.0,
  tenure: 0.0,
  positiveScore: humanSPlus(ME_ID),
  score: humanScore(ME_ID),
  scoreAtRisk: humanScoreAtRisk(ME_ID),
  tier: tierOf(ME_ID),
  depth: depthOf(ME_ID),
  gates: gatesFor(ME_ID),
  breakdown: ME_BREAKDOWN,
  slots: ME_SLOTS,
  weakestLink: {
    voucherEnsName: "bob.aval.eth",
    contribution: ME_BREAKDOWN[1]!.contribution,
    scoreIfExpired: meScoreIfBobExpires,
    currentTier: tierOf(ME_ID),
    tierIfExpired: meTierIfBobExpires,
    losesTier: meTierIfBobExpires < tierOf(ME_ID),
    daysUntilExpiry: ME_BREAKDOWN[1]!.daysUntilExpiry,
  },
  presence: ME_PRESENCE,
  credentialStatus: "active",
  credentialExpiresAt: iso(47),
};

export const ALICE = voucherSummary("alice.aval.eth");
export const BOB = voucherSummary("bob.aval.eth");
export const DAVE = voucherSummary("dave.carol.aval.eth");
export const ERIN = voucherSummary("erin.carol.aval.eth");
export const GRACE = voucherSummary("grace.bob.aval.eth");

// ─── explore — honest path vs. six-account collusion ring ───────────────────────────────────────
// docs/07-app-api.md §2.4: "both live, both at their real scores — 35.0 and 10.0."

const HONEST_IDS = ["anchor1.aval.eth", "anchor2.aval.eth", "alice.aval.eth", "bob.aval.eth", ME_ID, "dave.carol.aval.eth"];

function edgeContribution(voucher: string, vouchee: string): { contribution: number; counted: boolean; reason: string | null } {
  const row = breakdownFor(vouchee).vouchers.find((v) => v.voucher === voucher);
  if (!row) return { contribution: 0, counted: false, reason: "edge not found" };
  return { contribution: centiToScore(row.contribution), counted: row.counted, reason: voucherReasonText(row) };
}

export const EXPLORE_HONEST: ExploreScenario = {
  label: "Honest path",
  exhibit: "EXHIBIT A",
  description: "Every edge points down from an Orb anchor. Depth ordering lets each vouch count exactly once.",
  nodes: HONEST_IDS.map((id) => ({
    ensName: id,
    address: addressFor(id),
    kind: "member" as AccountKind,
    score: humanScore(id),
    tier: tierOf(id),
    depth: depthOf(id),
    isAnchor: ACCOUNTS.find((a) => a.id === id)?.isAnchor ?? false,
  })),
  edges: CORE_VOUCHES.filter((e) => HONEST_IDS.includes(e.voucher) && HONEST_IDS.includes(e.vouchee)).map((e) => {
    const info = edgeContribution(e.voucher, e.vouchee);
    return {
      from: e.voucher,
      to: e.vouchee,
      contribution: info.contribution,
      counted: info.counted,
      reason: info.counted ? null : (info.reason ?? "same depth or higher — doesn't count"),
    };
  }),
  finalScore: humanScore(ME_ID),
  finalTier: tierOf(ME_ID),
  gates: gatesFor(ME_ID),
};

export const EXPLORE_RING: ExploreScenario = {
  label: "Six-account collusion ring",
  exhibit: "EXHIBIT B",
  description: "Six phones on a table, fully mutual. A valid solution to the scoring equation — and the least fixed point ignores it.",
  nodes: RING_IDS.map((id) => ({
    ensName: id,
    address: addressFor(id),
    kind: "member" as AccountKind,
    score: humanScore(id),
    tier: tierOf(id),
    depth: depthOf(id),
    isAnchor: false,
  })),
  edges: RING_VOUCHES.map((e) => {
    const info = edgeContribution(e.voucher, e.vouchee);
    return {
      from: e.voucher,
      to: e.vouchee,
      contribution: info.contribution,
      counted: info.counted,
      reason: info.counted ? null : (info.reason ?? "no path to any anchor"),
    };
  }),
  finalScore: humanScore(RING_IDS[0]!),
  finalTier: tierOf(RING_IDS[0]!),
  gates: gatesFor(RING_IDS[0]!),
};

export const EXPLORE_SCENARIOS: ExploreScenario[] = [EXPLORE_HONEST, EXPLORE_RING];

// ─── reports — docs/12-reporting.md §3, docs/01-trust-math.md §7 ────────────────────────────────
// filedAt / challenge-window / reasonCode have no engine equivalent (the engine only ever sees
// `upheldAt`, never a filing time or a dispute-window length — those are indexer/contract facts),
// so they're supplied here per report, alongside every weight/decay/status number, which all come
// straight from `RESULT.reportWeights` (R-8/R-1).
const REPORT_DISPLAY_META: Record<string, { filedAgoDays: number; reasonCode: string; challengeWindowHours: number | null }> = {
  rpt_pending_henry: { filedAgoDays: 1, reasonCode: "SUSPECTED_SYBIL", challengeWindowHours: 72 },
  rpt_decayed_anchor2: { filedAgoDays: OLD_UPHELD_AGO_DAYS + 3, reasonCode: "MISREPRESENTED_AFFILIATION", challengeWindowHours: null },
  rpt_upheld_filed_by_me: { filedAgoDays: 48, reasonCode: "COLLUSION_RING", challengeWindowHours: null },
};

function reportStatus(r: Report, decayedWeight: number): ReportStatus {
  if (r.state === "rejected" || r.state === "withdrawn") return "rejected";
  if (r.state === "pending") return "pending";
  return decayedWeight === 0 ? "decayed" : "upheld";
}

function reporterScoreCenti(reporterId: string): number {
  const acct = ACCOUNTS.find((a) => a.id === reporterId);
  if (acct?.kind === "platform") return RESULT.sPlatform[reporterId] ?? 0;
  return RESULT.score[reporterId] ?? BASE;
}

export const REPORTS: ReportEntry[] = GRAPH_REPORTS.map((r): ReportEntry => {
  const rw = RESULT.reportWeights[r.id];
  const meta = REPORT_DISPLAY_META[r.id]!;
  const reporterAcct = ACCOUNTS.find((a) => a.id === r.reporter);
  const reporterKind: AccountKind = reporterAcct?.kind === "platform" ? "platform" : reporterAcct?.isAnchor ? "anchor" : "member";
  const baseWeight = rw?.baseWeight ?? 0;
  const decayedW = rw?.decayedWeight ?? 0;
  const filedAtIso = iso(-meta.filedAgoDays);

  return {
    id: r.id,
    direction: r.target === ME_ID ? "against" : "filed",
    reporter: { ensName: r.reporter, kind: reporterKind, score: centiToScore(reporterScoreCenti(r.reporter)) },
    target: r.target,
    status: reportStatus(r, decayedW),
    weight: centiToScore(decayedW),
    filedAt: filedAtIso,
    upheldAt: r.state === "upheld" && r.upheldAt !== undefined ? new Date(r.upheldAt * 1000).toISOString() : null,
    decayRemainingPct: baseWeight > 0 ? Math.round((decayedW / baseWeight) * 100) : 0,
    challengeDeadline:
      meta.challengeWindowHours !== null
        ? new Date(new Date(filedAtIso).getTime() + meta.challengeWindowHours * 60 * 60 * 1000).toISOString()
        : null,
    reasonCode: meta.reasonCode,
  };
});

// ─── platform — docs/13-platforms.md §3, docs/01-trust-math.md §12.3 "4 x T1 @ 50" row ──────────

const platformSpCenti = RESULT.sPlatform[PLATFORM_ID] ?? 0;

export const PLATFORM: PlatformScoreResult = {
  address: addressFor(PLATFORM_ID),
  ensName: PLATFORM_ID,
  score: centiToScore(platformSpCenti),
  tier: platformTierFromEngine(RESULT.platformTier[PLATFORM_ID]),
  voucherCount: PLATFORM_VOUCHES.length,
  bondAval: 5_200, // no engine equivalent — bond amount is a token-vault fact (docs/11-token-vault.md)
  requestsLast30d: 812, // no engine equivalent — request volume is a gateway/analytics metric
  upheldRatePct: 82, // no engine equivalent — historical report-outcome ratio, not a score input
  gates: {
    g1ScoreThreshold: platformSpCenti >= P1,
    g2TwoDistinctVouchers: new Set(PLATFORM_VOUCHES.map((pv) => pv.voucher)).size >= MIN_VOUCHERS,
    g3BondPosted: true, // no engine equivalent — bond posting is on-chain registry state
  },
};

// ─── agent — docs/04-ens.md §4, docs/07-app-api.md §2.5 ──────────────────────────────────────────

export const AGENT: AgentRecord = {
  subname: `trader.${ME_ID}`,
  operator: ME_ID,
  operatorScore: humanScore(ME_ID),
  inheritedTier: tierOf(ME_ID),
  endpointMcp: `https://mcp.aval.xyz/agent/trader.${ME_ID}`,
  endpointA2a: `https://a2a.aval.xyz/trader.${ME_ID}`,
  ensip26: {
    "agent-context": `# trader.${ME_ID}\n\nAutonomous trading agent. Operated by ${ME_ID} (Aval tier ${tierOf(
      ME_ID,
    )}, score ${humanScore(ME_ID).toFixed(1)}).\n\n**Delegated authority:** this agent inherits tier ${tierOf(
      ME_ID,
    )}. It CANNOT issue vouches — vouching requires human presence, and ENSIP-26 agents have none.`,
    "agent-endpoint[mcp]": `https://mcp.aval.xyz/agent/trader.${ME_ID}`,
    "agent-endpoint[a2a]": `https://a2a.aval.xyz/trader.${ME_ID}`,
    "agent-endpoint[web]": `https://aval.xyz/a/trader.${ME_ID}`,
  },
  ensip25RegistrationKey: `agent-registration[eip155:480:0x9F2b...4C11][0x01]`,
};

// ─── candidates — prospective vouchers for ME (docs/07-app-api.md §3) ───────────────────────────

export const CANDIDATES: CandidateVoucher[] = [
  {
    ensName: GRACE.ensName,
    address: GRACE.address,
    score: GRACE.score,
    tier: GRACE.tier,
    mutualConnections: 1, // no engine equivalent — "shared connections" isn't a scoring concept;
    // both ME and grace are reachable via bob, but this exact count is authored, not computed.
    slotsFree: 3, // no engine equivalent — see ME_SLOTS comment on slot bookkeeping.
  },
  {
    ensName: HENRY_ID,
    address: addressFor(HENRY_ID),
    score: humanScore(HENRY_ID),
    tier: tierOf(HENRY_ID),
    mutualConnections: 0,
    slotsFree: 2, // no engine equivalent — see ME_SLOTS comment.
  },
];

// ─── vouch simulation — docs/07-app-api.md §2.3 step 2 preview ──────────────────────────────────
// Reproduces the exact moment bob's vouch lands on carol: 22.5 -> 35.0, Tier 0 -> Tier 1 — and its
// side effects downstream (anyone whose own score depends, even indirectly, on carol's).

function secondaryEffectsBetween(before: EngineOutput, after: EngineOutput, exclude: string): SimulateVouchStep[] {
  return ACCOUNTS.filter((a) => a.kind === "human" && a.id !== exclude)
    .map((a) => ({
      ensName: a.id,
      before: centiToScore(before.score[a.id] ?? BASE),
      after: centiToScore(after.score[a.id] ?? BASE),
    }))
    .filter((s) => s.before !== s.after);
}

export const VOUCH_SIMULATION: SimulateVouchResult = {
  voucher: "bob.aval.eth",
  target: ME_ID,
  targetBefore: { score: meScoreIfBobExpires, tier: meTierIfBobExpires },
  targetAfter: { score: humanScore(ME_ID), tier: tierOf(ME_ID) },
  promotes: meTierIfBobExpires < tierOf(ME_ID),
  voucherSlotsBefore: 3, // no engine equivalent — see ME_SLOTS comment on slot bookkeeping.
  voucherSlotsAfter: 2,
  nextVouchAvailableInHours: 24, // no engine equivalent — rate-limit window, a contract fact.
  secondaryEffects: secondaryEffectsBetween(RESULT_WITHOUT_BOB, RESULT, ME_ID),
};

// ─── generic score lookup — powers /api/score/[address] and /api/explain/[address] for accounts
// other than ME, which is fully hand-curated above. Deterministic, not random: edge metadata is a
// stable function of edge index, not Math.random(), so repeated requests return identical bytes. ──

function genericBreakdown(id: string): VouchContribution[] {
  return breakdownFor(id).vouchers.map((row, i) => {
    const issuedAgoDays = 10 + ((i * 17) % 60);
    const expiresInDays = 90 - issuedAgoDays;
    return contributionRowFromEngine(row, { issuedAgoDays, expiresInDays });
  });
}

export function getScoreResult(idOrAddress: string): ScoreResult | undefined {
  if (idOrAddress === ME_ID || idOrAddress === ME.address) return ME;
  const acc = ACCOUNTS.find((a) => a.kind === "human" && (a.id === idOrAddress || addressFor(a.id) === idOrAddress));
  if (!acc) return undefined;
  const id = acc.id;
  const t = tierOf(id);
  return {
    address: addressFor(id),
    ensName: id,
    kind: acc.isAnchor ? "anchor" : "member",
    ...(acc.isAnchor ? { anchorSource: "orb" as const } : {}),
    base: acc.isAnchor ? 100.0 : 10.0,
    tenure: 0,
    positiveScore: humanSPlus(id),
    score: humanScore(id),
    scoreAtRisk: humanScoreAtRisk(id),
    tier: t,
    depth: depthOf(id),
    gates: gatesFor(id),
    breakdown: acc.isAnchor ? [] : genericBreakdown(id),
    slots: acc.isAnchor
      ? { total: 10, used: 0, free: 10 }
      : { total: t >= 1 ? 3 : 0, used: 0, free: t >= 1 ? 3 : 0 },
    weakestLink: null,
    presence: null,
    credentialStatus: "active",
    credentialExpiresAt: iso(60),
  };
}

/** Prose for /api/explain/[address] — docs/07-app-api.md §3. */
export function explainProse(idOrAddress: string): string | undefined {
  const r = getScoreResult(idOrAddress);
  if (!r) return undefined;
  if (r.kind === "anchor") {
    return `${r.ensName} is an Orb-verified anchor. Its score is fixed at 100.00 and ignores every inbound edge, positive or negative (docs/01-trust-math.md §2) — it is depth 0 by definition, the externally-grounded floor the rest of the graph is measured from.`;
  }
  const counted = r.breakdown.filter((b) => b.counted);
  const zero = r.breakdown.filter((b) => !b.counted);
  const countedSum = counted.reduce((sum, b) => sum + b.contribution, 0);
  const parts: string[] = [];
  parts.push(
    `${r.ensName} is Tier ${r.tier} with a score of ${r.score.toFixed(1)}, at depth ${r.depth ?? "∞"} from the nearest Orb anchor.`,
  );
  parts.push(
    `That score is base ${r.base.toFixed(1)} plus ${counted
      .map((b) => `${b.voucher.ensName} contributing +${b.contribution.toFixed(1)} (${b.voucher.score.toFixed(1)} x 0.25)`)
      .join(", ")}${counted.length ? ` = ${(r.base + countedSum).toFixed(1)}` : ""}.`,
  );
  if (zero.length) {
    parts.push(zero.map((b) => `${b.voucher.ensName} also vouches but contributes +0.0 — ${b.reason}`).join(" "));
  }
  if (r.weakestLink) {
    parts.push(
      `If ${r.weakestLink.voucherEnsName}'s vouch expires, the score drops to ${r.weakestLink.scoreIfExpired.toFixed(1)}${
        r.weakestLink.losesTier ? ` and Tier ${r.weakestLink.currentTier} is lost` : ""
      }.`,
    );
  }
  return parts.join(" ");
}

/** /api/simulate/vouch — docs/07-app-api.md §2.3 step 2. Genuinely simulates the hypothetical edge
 *  by adding it to the graph and calling `compute()` again — not a standalone "voucher.score x
 *  0.25" approximation, which (unlike the real engine) wouldn't even check depth ordering. */
export function simulateVouch(voucherId: string, targetId: string): SimulateVouchResult {
  if (voucherId === "bob.aval.eth" && targetId === ME_ID) return VOUCH_SIMULATION;

  const voucherAcc = ACCOUNTS.find((a) => a.id === voucherId && a.kind === "human");
  const targetAcc = ACCOUNTS.find((a) => a.id === targetId && a.kind === "human");
  if (!voucherAcc || !targetAcc) {
    return {
      voucher: voucherId,
      target: targetId,
      targetBefore: { score: 10, tier: 0 },
      targetAfter: { score: 10, tier: 0 },
      promotes: false,
      voucherSlotsBefore: 0,
      voucherSlotsAfter: 0,
      nextVouchAvailableInHours: 24,
      secondaryEffects: [],
    };
  }

  const alreadyVouches = ALL_VOUCHES.some((v) => v.voucher === voucherId && v.vouchee === targetId && v.active);
  const afterResult = alreadyVouches
    ? RESULT
    : compute({ ...ENGINE_INPUT, vouches: [...ALL_VOUCHES, mkVouch(voucherId, targetId)] });

  const beforeScore = humanScore(targetId);
  const beforeTier = tierOf(targetId);
  const afterScore = centiToScore(afterResult.score[targetId] ?? BASE);
  const afterTier = (afterResult.tier[targetId] ?? 0) as Tier;

  return {
    voucher: voucherId,
    target: targetId,
    targetBefore: { score: beforeScore, tier: beforeTier },
    targetAfter: { score: afterScore, tier: afterTier },
    promotes: afterTier > beforeTier,
    voucherSlotsBefore: 3, // no engine equivalent — see ME_SLOTS comment.
    voucherSlotsAfter: 2,
    nextVouchAvailableInHours: 24, // no engine equivalent — rate-limit window, a contract fact.
    secondaryEffects: alreadyVouches ? [] : secondaryEffectsBetween(RESULT, afterResult, targetId),
  };
}

// ─── identity directory + gate + path — docs/07-app-api.md §3 ───────────────────────────────────

interface DirectoryEntry {
  id: string;
  kind: AccountKind;
  credential: "orb" | "selfie" | "document";
  registeredAgoDays: number;
}

const DIRECTORY: DirectoryEntry[] = [
  { id: "anchor1.aval.eth", kind: "anchor", credential: "orb", registeredAgoDays: 400 },
  { id: "anchor2.aval.eth", kind: "anchor", credential: "orb", registeredAgoDays: 380 },
  { id: "alice.aval.eth", kind: "member", credential: "selfie", registeredAgoDays: 200 },
  { id: "bob.aval.eth", kind: "member", credential: "selfie", registeredAgoDays: 190 },
  { id: ME_ID, kind: "member", credential: "selfie", registeredAgoDays: 214 },
  { id: "dave.carol.aval.eth", kind: "member", credential: "selfie", registeredAgoDays: 5 },
  { id: "erin.carol.aval.eth", kind: "member", credential: "selfie", registeredAgoDays: 5 },
  { id: "grace.bob.aval.eth", kind: "member", credential: "selfie", registeredAgoDays: 60 },
  { id: PLATFORM_ID, kind: "platform", credential: "document", registeredAgoDays: 120 },
];

export function findIdentity(idOrAddress: string): IdentityResult | undefined {
  const entry = DIRECTORY.find((d) => d.id === idOrAddress || addressFor(d.id) === idOrAddress);
  if (!entry) return undefined;
  return {
    address: addressFor(entry.id),
    ensName: entry.id,
    kind: entry.kind,
    registeredAt: iso(-entry.registeredAgoDays),
    credential: entry.credential,
    credentialStatus: "active",
    ...(entry.kind === "anchor" ? { anchorSource: "orb" as const } : {}),
  };
}

export function checkGate(idOrAddress: string, policy: GatePolicy): GateResult {
  const identity = findIdentity(idOrAddress);
  if (!identity) return { allow: false, reasons: ["identity_not_found"] };
  const reasons: string[] = [];
  const isPlatform = identity.kind === "platform";
  const t = isPlatform ? (RESULT.platformTier[identity.ensName] ?? 0) : tierOf(identity.ensName);
  const s = isPlatform ? centiToScore(RESULT.sPlatform[identity.ensName] ?? 0) : humanScore(identity.ensName);
  if (policy.minTier !== undefined && t < policy.minTier) reasons.push(`tier ${t} below required tier ${policy.minTier}`);
  if (policy.minScore !== undefined && s < policy.minScore) reasons.push(`score ${s.toFixed(1)} below required score ${policy.minScore.toFixed(1)}`);
  if (policy.requireCredential && identity.credential !== policy.requireCredential) {
    reasons.push(`credential ${identity.credential} does not satisfy required credential ${policy.requireCredential}`);
  }
  return { allow: reasons.length === 0, reasons };
}

function parentOf(id: string): string | undefined {
  const d = RESULT.depth[id];
  if (d === undefined) return undefined;
  const edge = ALL_VOUCHES.find((e) => e.vouchee === id && RESULT.depth[e.voucher] === d - 1);
  return edge?.voucher;
}

/** Walks from `fromEnsName` back to the literal string "anchor", or to a specific target name. */
export function findPath(fromEnsName: string, toEnsName: string): PathResult {
  // R-12 (docs/97-review-engine-app.md): an entirely unknown starting identity must yield zero
  // hops, so the route's existing `hops.length === 0` check 404s — not a single synthetic hop for
  // an id that resolves to nothing.
  const fromKnown = ACCOUNTS.some((a) => a.id === fromEnsName);
  if (!fromKnown) return { from: fromEnsName, to: toEnsName, found: false, hops: [] };

  const hops: PathResult["hops"] = [];
  let cursor: string | undefined = fromEnsName;
  let previous: string | undefined;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    const contributionCenti =
      previous === undefined ? 0 : (breakdownFor(previous).vouchers.find((v) => v.voucher === cursor)?.contribution ?? 0);
    hops.push({
      ensName: cursor,
      address: addressFor(cursor),
      depth: depthOf(cursor) ?? -1,
      contribution: centiToScore(contributionCenti),
    });
    if ((toEnsName === "anchor" && (RESULT.depth[cursor] ?? Number.POSITIVE_INFINITY) === 0) || cursor === toEnsName) {
      return { from: fromEnsName, to: toEnsName, found: true, hops };
    }
    previous = cursor;
    cursor = parentOf(cursor);
  }
  return { from: fromEnsName, to: toEnsName, found: false, hops };
}
