/**
 * THE ONLY PLACE NUMBERS COME FROM.
 *
 * Every score, weight, countdown and stamp rendered anywhere in this app is exported from this
 * file (or derived from something exported here via src/lib/format.ts). Nothing is typed directly
 * into JSX.
 *
 * The fixture graph below is run through `computeStage1`, a hand-written but faithful port of the
 * stage-1 (positive score) reference algorithm in docs/01-trust-math.md §15 — same BFS-by-depth
 * ordering, same integer centi-point truncation (§10), same gates (§11). Nothing here is typed in
 * by hand as a final answer; it is *computed* from a graph, the same way the real engine
 * (docs/07-app-api.md §5) will compute it. That is what makes the numbers verifiable against
 * docs/01-trust-math.md §12.1 rather than merely plausible.
 *
 * When @aval/engine exists, this file is the thing that gets deleted — everything that imports it
 * should instead call src/lib/api.ts against real endpoints.
 */

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
  ScoreResult,
  SimulateVouchResult,
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

// ─── stage-1 engine — docs/01-trust-math.md §3-6, §10, §11, §15 ─────────────────────────────────

const BASE = 1_000; // 10.00, centi-points
const ANCHOR = 10_000; // 100.00
const CAP_POS = 2_000; // 20.00
const T1 = 3_000; // 30.00
const T2 = 10_000; // 100.00
const MAX_DEPTH = 3;
const MAX_ROUNDS = 8;

/** min(s * num/den, cap), truncated toward zero — the single arithmetic rule (I-15). */
function w(s: number, num: number, den: number, cap: number): number {
  return Math.min(Math.trunc((s * num) / den), cap);
}

/** m+ = 0.25, cap+ = 20 (docs/01-trust-math.md §4). */
export function positiveWeight(sCenti: number): number {
  return w(sCenti, 25, 100, CAP_POS);
}

/** m- = 0.50, cap- = 40 (docs/01-trust-math.md §7.1). */
export function reportWeight(sCenti: number): number {
  return w(sCenti, 50, 100, 4_000);
}

/** Linear decay to zero over 180 days (docs/01-trust-math.md §7.4). */
export function decayFactor(daysSinceUpheld: number): number {
  return Math.max(0, 1 - daysSinceUpheld / 180);
}

interface EngineAccount {
  id: string; // ensName, graph key
  isAnchor: boolean;
}
interface EngineEdge {
  src: string; // voucher
  dst: string; // vouchee
}
interface EngineResult {
  depth: Map<string, number>; // Infinity if unreachable
  sp: Map<string, number>; // centi-points
  inboundCount: Map<string, number>;
  gates: Map<string, { g1: boolean; g2: boolean; g3: boolean }>;
  tier: Map<string, Tier>;
}

function bfsDepth(origins: Set<string>, edges: EngineEdge[], accounts: EngineAccount[]): Map<string, number> {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const list = adjacency.get(e.src) ?? [];
    list.push(e.dst);
    adjacency.set(e.src, list);
  }
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const o of origins) {
    depth.set(o, 0);
    queue.push(o);
  }
  let head = 0;
  while (head < queue.length) {
    const u = queue[head];
    head += 1;
    const d = depth.get(u ?? "") ?? 0;
    if (u === undefined || d >= MAX_DEPTH) continue;
    for (const v of adjacency.get(u) ?? []) {
      if (!depth.has(v)) {
        depth.set(v, d + 1);
        queue.push(v);
      }
    }
  }
  for (const a of accounts) if (!depth.has(a.id)) depth.set(a.id, Infinity);
  return depth;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Stage 1 (positive human scores) + gates 1-3 + tier, from docs/01-trust-math.md §15.
 * Reports (stage 3-4) are out of scope — none of the mock accounts below carry an upheld report,
 * so `score === positiveScore` for every one of them. The Reports page fixture applies
 * `reportWeight` / `decayFactor` independently, illustratively, without feeding back into this pass
 * (matching the real pipeline's strict stratification, §3).
 */
function computeStage1(accounts: EngineAccount[], edges: EngineEdge[]): EngineResult {
  const inbound = new Map<string, EngineEdge[]>();
  for (const e of edges) {
    const list = inbound.get(e.dst) ?? [];
    list.push(e);
    inbound.set(e.dst, list);
  }

  let origins = new Set(accounts.filter((a) => a.isAnchor).map((a) => a.id));
  let depth = new Map<string, number>();
  let sp = new Map<string, number>();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    depth = bfsDepth(origins, edges, accounts);
    sp = new Map(accounts.map((a) => [a.id, a.isAnchor ? ANCHOR : BASE]));

    for (let d = 1; d <= MAX_DEPTH; d++) {
      for (const a of accounts) {
        if (a.isAnchor || depth.get(a.id) !== d) continue;
        let sum = 0;
        for (const e of inbound.get(a.id) ?? []) {
          const srcDepth = depth.get(e.src) ?? Infinity;
          if (srcDepth < d) sum += positiveWeight(sp.get(e.src) ?? BASE);
        }
        sp.set(a.id, BASE + sum);
      }
    }

    const nextOrigins = new Set(origins);
    for (const a of accounts) {
      if (a.isAnchor) continue;
      const g3 = (depth.get(a.id) ?? Infinity) <= MAX_DEPTH;
      const g2 = (inbound.get(a.id)?.length ?? 0) >= 2;
      if ((sp.get(a.id) ?? 0) >= T2 && g2 && g3) nextOrigins.add(a.id);
    }
    if (setsEqual(nextOrigins, origins)) break;
    origins = nextOrigins;
  }

  const gates = new Map<string, { g1: boolean; g2: boolean; g3: boolean }>();
  const tier = new Map<string, Tier>();
  const inboundCount = new Map<string, number>();

  for (const a of accounts) {
    const s = sp.get(a.id) ?? BASE;
    const inCount = inbound.get(a.id)?.length ?? 0;
    inboundCount.set(a.id, inCount);
    const g2 = inCount >= 2;
    const g3 = a.isAnchor ? true : (depth.get(a.id) ?? Infinity) <= MAX_DEPTH;
    let t: Tier = 0;
    let g1 = s >= T1;
    if (a.isAnchor) {
      t = 2;
      g1 = true;
    } else if (s >= T2 && g2 && g3) {
      t = 2;
    } else if (s >= T1 && g2 && g3) {
      t = 1;
    }
    gates.set(a.id, { g1, g2, g3 });
    tier.set(a.id, t);
  }

  return { depth, sp, inboundCount, gates, tier };
}

// ─── the fixture graph ───────────────────────────────────────────────────────────────────────────
//
//   anchor1, anchor2          Orb-verified, depth 0
//   alice, bob                each vouched by both anchors -> 50.00, Tier 1, depth 1
//                              (docs/01-trust-math.md §12.1 "2 anchors" row)
//   carol                     "ME" — vouched by alice AND bob -> 35.00, Tier 1, depth 2
//                              (§12.1 "2 x T1 @ 50" row; docs/07-app-api.md §2.2's worked example)
//   dave                      vouched by carol only (depth 3, 18.75, Tier 0) — and vouches carol
//                              BACK. That reciprocal edge is the zero-contribution row: dave's depth
//                              (3) is not strictly lower than carol's (2), so it contributes +0.0.
//   erin                      vouched by carol only (depth 3, 18.75, Tier 0) — carol's 2nd used slot,
//                              used in the vouch-simulation secondary-effect fixture.
//   grace                     vouched by bob only (depth 2, 35.00 if 2 vouchers — here 1, so blocked)
//                              used as a Vouch-candidate example.
//   ring1..ring6               fully mutual (K6) clique, zero path to any anchor
//                              (§12.1 "6-account mutual ring" row: 10.00, Tier 0, Blocked x2)

const ACCOUNTS: EngineAccount[] = [
  { id: "anchor1.aval.eth", isAnchor: true },
  { id: "anchor2.aval.eth", isAnchor: true },
  { id: "alice.aval.eth", isAnchor: false },
  { id: "bob.aval.eth", isAnchor: false },
  { id: "carol.alice.aval.eth", isAnchor: false },
  { id: "dave.carol.aval.eth", isAnchor: false },
  { id: "erin.carol.aval.eth", isAnchor: false },
  { id: "grace.bob.aval.eth", isAnchor: false },
  // docs/04-ens.md §1.2: names like this "resolve to nothing, because none of those labels descend
  // from aval.eth" — the ring is unrepresentable in the real namespace. Kept as flat mock ids here
  // only so the fixture graph has six distinct, clearly-labelled ring accounts to compute over.
  ...["ring1", "ring2", "ring3", "ring4", "ring5", "ring6"].map((r) => ({
    id: `${r}.eth`,
    isAnchor: false,
  })),
];

const RING_IDS = ACCOUNTS.filter((a) => a.id.startsWith("ring")).map((a) => a.id);

const CORE_EDGES: EngineEdge[] = [
  { src: "anchor1.aval.eth", dst: "alice.aval.eth" },
  { src: "anchor2.aval.eth", dst: "alice.aval.eth" },
  { src: "anchor1.aval.eth", dst: "bob.aval.eth" },
  { src: "anchor2.aval.eth", dst: "bob.aval.eth" },
  { src: "alice.aval.eth", dst: "carol.alice.aval.eth" },
  { src: "bob.aval.eth", dst: "carol.alice.aval.eth" },
  { src: "carol.alice.aval.eth", dst: "dave.carol.aval.eth" },
  { src: "dave.carol.aval.eth", dst: "carol.alice.aval.eth" }, // reciprocal — zero-contribution row
  { src: "carol.alice.aval.eth", dst: "erin.carol.aval.eth" },
  { src: "bob.aval.eth", dst: "grace.bob.aval.eth" },
];

const RING_EDGES: EngineEdge[] = RING_IDS.flatMap((src) => RING_IDS.filter((dst) => dst !== src).map((dst) => ({ src, dst })));

const ALL_EDGES: EngineEdge[] = [...CORE_EDGES, ...RING_EDGES];

const RESULT = computeStage1(ACCOUNTS, ALL_EDGES);

// Same graph, minus bob -> carol, for the weakest-link simulation.
const EDGES_WITHOUT_BOB: EngineEdge[] = ALL_EDGES.filter(
  (e) => !(e.src === "bob.aval.eth" && e.dst === "carol.alice.aval.eth"),
);
const RESULT_WITHOUT_BOB = computeStage1(ACCOUNTS, EDGES_WITHOUT_BOB);

function score(id: string): number {
  return centiToScore(RESULT.sp.get(id) ?? BASE);
}
function depth(id: string): number | null {
  const d = RESULT.depth.get(id) ?? Infinity;
  return Number.isFinite(d) ? d : null;
}
function tier(id: string): Tier {
  return RESULT.tier.get(id) ?? 0;
}
function gates(id: string): Gates {
  const g = RESULT.gates.get(id) ?? { g1: false, g2: false, g3: false };
  return {
    g1ScoreThreshold: g.g1,
    g2TwoDistinctVouchers: g.g2,
    g3PathToOrigin: g.g3,
    g4NoRecentUpheldReport: true,
  };
}
function voucherSummary(id: string): VoucherSummary {
  const acc = ACCOUNTS.find((a) => a.id === id);
  return {
    address: addressFor(id),
    ensName: id,
    score: score(id),
    tier: tier(id),
    depth: depth(id),
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

const ME_ID = "carol.alice.aval.eth";

function contributionRow(
  voucherId: string,
  targetDepth: number,
  edge: { issuedAgoDays: number; expiresInDays: number },
): VouchContribution {
  const voucher = voucherSummary(voucherId);
  const srcDepth = RESULT.depth.get(voucherId) ?? Infinity;
  const counted = srcDepth < targetDepth;
  const raw = positiveWeight(RESULT.sp.get(voucherId) ?? BASE);
  return {
    voucher,
    weight: 0.25,
    contribution: counted ? centiToScore(raw) : 0,
    counted,
    reason: counted
      ? null
      : `${displayLabel(voucherId)} is at depth ${Number.isFinite(srcDepth) ? srcDepth : "∞"}, which is not lower ` +
        `than yours, so it doesn't count.`,
    issuedAt: iso(-edge.issuedAgoDays),
    expiresAt: iso(edge.expiresInDays),
    daysUntilExpiry: edge.expiresInDays,
    expiringSoon: edge.expiresInDays <= 21,
  };
}

function displayLabel(ensName: string): string {
  const [first] = ensName.split(".");
  return first ? first[0]!.toUpperCase() + first.slice(1) : ensName;
}

const ME_BREAKDOWN: VouchContribution[] = [
  contributionRow("alice.aval.eth", 2, { issuedAgoDays: 16, expiresInDays: 74 }),
  contributionRow("bob.aval.eth", 2, { issuedAgoDays: 72, expiresInDays: 18 }),
  contributionRow("dave.carol.aval.eth", 2, { issuedAgoDays: 5, expiresInDays: 85 }),
];

const ME_SLOTS: Slots = { total: 3, used: 2, free: 1 }; // carol vouched for dave + erin

const meScoreIfBobExpires = centiToScore(RESULT_WITHOUT_BOB.sp.get(ME_ID) ?? BASE);
const meTierIfBobExpires = RESULT_WITHOUT_BOB.tier.get(ME_ID) ?? 0;

// docs/16-presence-drip.md §9 — an independent illustrative panel. Carol's own `tenure` field below
// is 0.00 so that the Home arithmetic line reads exactly "base 10.0 + 25.0 = 35.0"
// (docs/07-app-api.md §2.2); the drip/tenure panel demonstrates the *mechanism* using the documented
// formula (src/lib/format.ts `tenureFromDays`) rather than feeding back into this fixture's score.
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
  positiveScore: score(ME_ID),
  score: score(ME_ID),
  scoreAtRisk: score(ME_ID),
  tier: tier(ME_ID),
  depth: depth(ME_ID),
  gates: gates(ME_ID),
  breakdown: ME_BREAKDOWN,
  slots: ME_SLOTS,
  weakestLink: {
    voucherEnsName: "bob.aval.eth",
    contribution: ME_BREAKDOWN[1]!.contribution,
    scoreIfExpired: meScoreIfBobExpires,
    currentTier: tier(ME_ID),
    tierIfExpired: meTierIfBobExpires,
    losesTier: meTierIfBobExpires < tier(ME_ID),
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

export const EXPLORE_HONEST: ExploreScenario = {
  label: "Honest path",
  exhibit: "EXHIBIT A",
  description: "Every edge points down from an Orb anchor. Depth ordering lets each vouch count exactly once.",
  nodes: HONEST_IDS.map((id) => ({
    ensName: id,
    address: addressFor(id),
    kind: "member" as AccountKind,
    score: score(id),
    tier: tier(id),
    depth: depth(id),
    isAnchor: ACCOUNTS.find((a) => a.id === id)?.isAnchor ?? false,
  })),
  edges: CORE_EDGES.filter((e) => HONEST_IDS.includes(e.src) && HONEST_IDS.includes(e.dst)).map((e) => {
    const srcDepth = RESULT.depth.get(e.src) ?? Infinity;
    const dstDepth = RESULT.depth.get(e.dst) ?? Infinity;
    const counted = srcDepth < dstDepth;
    return {
      from: e.src,
      to: e.dst,
      contribution: counted ? centiToScore(positiveWeight(RESULT.sp.get(e.src) ?? BASE)) : 0,
      counted,
      reason: counted ? null : "same depth or higher — doesn't count",
    };
  }),
  finalScore: score(ME_ID),
  finalTier: tier(ME_ID),
  gates: gates(ME_ID),
};

export const EXPLORE_RING: ExploreScenario = {
  label: "Six-account collusion ring",
  exhibit: "EXHIBIT B",
  description: "Six phones on a table, fully mutual. A valid solution to the scoring equation — and the least fixed point ignores it.",
  nodes: RING_IDS.map((id) => ({
    ensName: id,
    address: addressFor(id),
    kind: "member" as AccountKind,
    score: score(id),
    tier: tier(id),
    depth: depth(id),
    isAnchor: false,
  })),
  edges: RING_EDGES.map((e) => ({ from: e.src, to: e.dst, contribution: 0, counted: false, reason: "no path to any anchor" })),
  finalScore: score(RING_IDS[0]!),
  finalTier: tier(RING_IDS[0]!),
  gates: gates(RING_IDS[0]!),
};

export const EXPLORE_SCENARIOS: ExploreScenario[] = [EXPLORE_HONEST, EXPLORE_RING];

// ─── reports — docs/12-reporting.md §3, docs/01-trust-math.md §7 ────────────────────────────────

const henryScore = 5_000; // 50.00, Tier 1 mid
const oldUpheldAgo = 185; // days — past the 180-day decay window
const filedAgo = 1;

export const REPORTS: ReportEntry[] = [
  {
    id: "rpt_pending_henry",
    direction: "against",
    reporter: { ensName: "henry.aval.eth", kind: "member", score: centiToScore(henryScore) },
    target: ME_ID,
    status: "pending",
    weight: centiToScore(reportWeight(henryScore)),
    filedAt: iso(-filedAgo),
    upheldAt: null,
    decayRemainingPct: 100,
    // docs/12-reporting.md §3: "0-72h challenge window", "t=72h resolution"
    challengeDeadline: new Date(new Date(iso(-filedAgo)).getTime() + 72 * 60 * 60 * 1000).toISOString(),
    reasonCode: "SUSPECTED_SYBIL",
  },
  {
    id: "rpt_decayed_anchor2",
    direction: "against",
    reporter: { ensName: "anchor2.aval.eth", kind: "anchor", score: centiToScore(ANCHOR) },
    target: ME_ID,
    status: "decayed",
    weight: 0,
    filedAt: iso(-(oldUpheldAgo + 3)),
    upheldAt: iso(-oldUpheldAgo),
    decayRemainingPct: Math.round(decayFactor(oldUpheldAgo) * 100),
    challengeDeadline: null,
    reasonCode: "MISREPRESENTED_AFFILIATION",
  },
  {
    id: "rpt_upheld_filed_by_me",
    direction: "filed",
    reporter: { ensName: ME_ID, kind: "member", score: score(ME_ID) },
    target: RING_IDS[0]!,
    status: "upheld",
    weight: Math.round(centiToScore(reportWeight(Math.round(score(ME_ID) * 100))) * decayFactor(45) * 100) / 100,
    filedAt: iso(-48),
    upheldAt: iso(-45),
    decayRemainingPct: Math.round(decayFactor(45) * 100),
    challengeDeadline: null,
    reasonCode: "COLLUSION_RING",
  },
];

// ─── platform — docs/13-platforms.md §3, docs/01-trust-math.md §12.3 "4 x T1 @ 50" row ──────────

const PLATFORM_ID = "marketpulse.aval.eth";
const platformVoucherScore = 5_000; // 50.00, Tier 1 mid, 4 vouchers
const platformSpCenti = 4 * positiveWeight(platformVoucherScore);

export const PLATFORM: PlatformScoreResult = {
  address: addressFor(PLATFORM_ID),
  ensName: PLATFORM_ID,
  score: centiToScore(platformSpCenti),
  tier: platformSpCenti >= 15_000 ? "P2" : platformSpCenti >= 4_000 ? "P1" : "P0",
  voucherCount: 4,
  bondAval: 5_200,
  requestsLast30d: 812,
  upheldRatePct: 82,
  gates: {
    g1ScoreThreshold: platformSpCenti >= 4_000,
    g2TwoDistinctVouchers: true,
    g3BondPosted: true,
  },
};

// ─── agent — docs/04-ens.md §4, docs/07-app-api.md §2.5 ──────────────────────────────────────────

export const AGENT: AgentRecord = {
  subname: `trader.${ME_ID}`,
  operator: ME_ID,
  operatorScore: score(ME_ID),
  inheritedTier: tier(ME_ID),
  endpointMcp: `https://mcp.aval.xyz/agent/trader.${ME_ID}`,
  endpointA2a: `https://a2a.aval.xyz/trader.${ME_ID}`,
  ensip26: {
    "agent-context": `# trader.${ME_ID}\n\nAutonomous trading agent. Operated by ${ME_ID} (Aval tier ${tier(
      ME_ID,
    )}, score ${score(ME_ID).toFixed(1)}).\n\n**Delegated authority:** this agent inherits tier ${tier(
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
    mutualConnections: 1, // both connected via bob
    slotsFree: 3,
  },
  {
    ensName: "henry.aval.eth",
    address: addressFor("henry.aval.eth"),
    score: centiToScore(henryScore),
    tier: 1,
    mutualConnections: 0,
    slotsFree: 2,
  },
];

// ─── vouch simulation — docs/07-app-api.md §2.3 step 2 preview ──────────────────────────────────
// Reproduces the exact moment bob's vouch lands on carol: 22.5 -> 35.0, Tier 0 -> Tier 1 — and its
// side effect on erin, whose contribution depends on carol's score, not just her depth.

const meBeforeBobCenti = RESULT_WITHOUT_BOB.sp.get(ME_ID) ?? BASE;
const meAfterBobCenti = RESULT.sp.get(ME_ID) ?? BASE;
const erinBeforeCenti = BASE + positiveWeight(meBeforeBobCenti);
const erinAfterCenti = BASE + positiveWeight(meAfterBobCenti);

export const VOUCH_SIMULATION: SimulateVouchResult = {
  voucher: "bob.aval.eth",
  target: ME_ID,
  targetBefore: { score: centiToScore(meBeforeBobCenti), tier: RESULT_WITHOUT_BOB.tier.get(ME_ID) ?? 0 },
  targetAfter: { score: centiToScore(meAfterBobCenti), tier: RESULT.tier.get(ME_ID) ?? 0 },
  promotes: (RESULT_WITHOUT_BOB.tier.get(ME_ID) ?? 0) < (RESULT.tier.get(ME_ID) ?? 0),
  voucherSlotsBefore: 3,
  voucherSlotsAfter: 2,
  nextVouchAvailableInHours: 24,
  secondaryEffects: [
    { ensName: "erin.carol.aval.eth", before: centiToScore(erinBeforeCenti), after: centiToScore(erinAfterCenti) },
  ],
};

// ─── generic score lookup — powers /api/score/[address] and /api/explain/[address] for accounts
// other than ME, which is fully hand-curated above. Deterministic, not random: edge metadata is a
// stable function of edge index, not Math.random(), so repeated requests return identical bytes. ──

function genericBreakdown(id: string): VouchContribution[] {
  const targetDepth = RESULT.depth.get(id) ?? Infinity;
  return ALL_EDGES.filter((e) => e.dst === id).map((e, i) => {
    const issuedAgoDays = 10 + ((i * 17) % 60);
    const expiresInDays = 90 - issuedAgoDays;
    return contributionRow(e.src, targetDepth, { issuedAgoDays, expiresInDays });
  });
}

export function getScoreResult(idOrAddress: string): ScoreResult | undefined {
  if (idOrAddress === ME_ID || idOrAddress === ME.address) return ME;
  const acc = ACCOUNTS.find((a) => a.id === idOrAddress || addressFor(a.id) === idOrAddress);
  if (!acc) return undefined;
  const id = acc.id;
  const s = score(id);
  const t = tier(id);
  return {
    address: addressFor(id),
    ensName: id,
    kind: acc.isAnchor ? "anchor" : "member",
    ...(acc.isAnchor ? { anchorSource: "orb" as const } : {}),
    base: acc.isAnchor ? 100.0 : 10.0,
    tenure: 0,
    positiveScore: s,
    score: s,
    scoreAtRisk: s,
    tier: t,
    depth: depth(id),
    gates: gates(id),
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

/** /api/simulate/vouch — docs/07-app-api.md §2.3 step 2. */
export function simulateVouch(voucherId: string, targetId: string): SimulateVouchResult {
  if (voucherId === "bob.aval.eth" && targetId === ME_ID) return VOUCH_SIMULATION;

  const voucher = getScoreResult(voucherId);
  const target = getScoreResult(targetId);
  if (!voucher || !target) {
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
  const contributionCenti = positiveWeight(Math.round(voucher.score * 100));
  const afterCenti = Math.round(target.score * 100) + contributionCenti;
  const afterScore = centiToScore(afterCenti);
  const afterTier: Tier = afterCenti >= T2 ? 2 : afterCenti >= T1 ? 1 : 0;
  return {
    voucher: voucherId,
    target: targetId,
    targetBefore: { score: target.score, tier: target.tier },
    targetAfter: { score: afterScore, tier: afterTier },
    promotes: afterTier > target.tier,
    voucherSlotsBefore: voucher.slots.free,
    voucherSlotsAfter: Math.max(0, voucher.slots.free - 1),
    nextVouchAvailableInHours: 24,
    secondaryEffects: [],
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
  const t = identity.ensName === ME_ID ? tier(ME_ID) : identity.kind === "anchor" ? 2 : tier(identity.ensName);
  const s = identity.ensName === ME_ID ? score(ME_ID) : identity.kind === "anchor" ? 100 : score(identity.ensName);
  if (policy.minTier !== undefined && t < policy.minTier) reasons.push(`tier ${t} below required tier ${policy.minTier}`);
  if (policy.minScore !== undefined && s < policy.minScore) reasons.push(`score ${s.toFixed(1)} below required score ${policy.minScore.toFixed(1)}`);
  if (policy.requireCredential && identity.credential !== policy.requireCredential) {
    reasons.push(`credential ${identity.credential} does not satisfy required credential ${policy.requireCredential}`);
  }
  return { allow: reasons.length === 0, reasons };
}

/** Walks from `fromEnsName` back to the literal string "anchor", or to a specific target name. */
export function findPath(fromEnsName: string, toEnsName: string): PathResult {
  const parentEdge = (id: string): EngineEdge | undefined => {
    const d = RESULT.depth.get(id) ?? Infinity;
    return ALL_EDGES.find((e) => e.dst === id && (RESULT.depth.get(e.src) ?? Infinity) === d - 1);
  };

  const hops: PathResult["hops"] = [];
  let cursor: string | undefined = fromEnsName;
  const visited = new Set<string>();
  while (cursor && !visited.has(cursor)) {
    visited.add(cursor);
    hops.push({
      ensName: cursor,
      address: addressFor(cursor),
      depth: depth(cursor) ?? -1,
      contribution: cursor === fromEnsName ? 0 : centiToScore(positiveWeight(RESULT.sp.get(cursor) ?? BASE)),
    });
    if ((toEnsName === "anchor" && (RESULT.depth.get(cursor) ?? Infinity) === 0) || cursor === toEnsName) {
      return { from: fromEnsName, to: toEnsName, found: true, hops };
    }
    cursor = parentEdge(cursor)?.src;
  }
  return { from: fromEnsName, to: toEnsName, found: false, hops };
}
