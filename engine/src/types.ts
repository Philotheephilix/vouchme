/**
 * Aval engine — input/output types.
 *
 * The engine is a pure function `(EngineInput) -> EngineOutput`. All monetary/score quantities
 * are integer centi-points (score × 100). Time is unix seconds, supplied by the caller via
 * `EngineInput.now` — the engine never reads the clock itself.
 */

/** The three account kinds that can exist in the graph (01-trust-math.md §1). Agents inherit
 *  their operator's tier and accrue nothing on their own; they are out of scope for scoring and
 *  are not a distinct kind here — represent an agent's action as taken by its operator account. */
export type AccountKind = "human" | "platform";

export type Tier = 0 | 1 | 2;
export type PlatformTier = 0 | 1 | 2;

export interface Account {
  /** Stable account identifier (address, or ENS name — caller's choice, used as a map key). */
  id: string;
  kind: AccountKind;
  /** Orb-verified anchor. Humans only. An anchor's score is fixed at ANCHOR (01-trust-math.md §2). */
  isAnchor?: boolean;
  /** Monotone count of claimed presence-drip epochs, feeds tenure(). Humans only. */
  epochsClaimed?: number;
  /** False excludes the account from the graph entirely (e.g. fraudulent/removed). Default true. */
  active?: boolean;
}

/** A human → human vouch edge. `active` is a caller-computed predicate: not expired, not
 *  revoked, both endpoints active (05-graph-data-layer.md §2.3 — expiry is query-time, not
 *  indexed state, so the caller resolves it against `now` before handing edges to the engine). */
export interface Vouch {
  voucher: string;
  vouchee: string;
  active: boolean;
}

/** A human → platform vouch edge. Platforms can never be the source of one of these — only ever
 *  the target (01-trust-math.md §1, §8; invariant I-16). */
export interface PlatformVouch {
  voucher: string;
  platform: string;
  active: boolean;
}

/** Lifecycle states relevant to scoring (see docs/12-reporting.md §5 `ReportRegistry.State`).
 *  ARBITRATION collapses into "pending" from the engine's point of view — no report weight until
 *  a terminal state is reached. MALICIOUS/REJECTED/WITHDRAWN reports never contribute. */
export type ReportState = "pending" | "upheld" | "rejected" | "withdrawn";

/** A report edge: human or platform → human, or human → platform (01-trust-math.md §1). */
export interface Report {
  id: string;
  reporter: string;
  target: string;
  state: ReportState;
  /** Unix seconds the report was upheld. Required when `state === "upheld"`; drives §7.4 decay. */
  upheldAt?: number;
  /** Platform reporters only: whether a prior attributed ScoreRequest against `target` exists
   *  (13-platforms.md §5). Reporting without one voids the report (01-trust-math.md §7.3). */
  queried?: boolean;
}

export interface EngineInput {
  /** Unix seconds. The only source of "current time" — the engine performs no I/O of its own. */
  now: number;
  accounts: Account[];
  vouches: Vouch[];
  platformVouches: PlatformVouch[];
  reports: Report[];
}

/** Per-report computed weight and validity, exposed for the `explain` module and for auditing. */
export interface ReportWeightResult {
  reportId: string;
  reporter: string;
  target: string;
  /** True if this report is not voided (voided reporter / conflict of interest / unqueried
   *  platform / terminal-rejected state). Decay/pending status is independent of validity. */
  valid: boolean;
  voidReason?: string;
  /** Weight before §7.4 decay is applied. */
  baseWeight: number;
  /** Weight after decay — what actually gets summed, subject to the top-K cut. */
  decayedWeight: number;
  /** True if this report is one of the top-K (by decayedWeight) *upheld* reports and so is
   *  subtracted in `score`. */
  countedTowardScore: boolean;
  /** True if this report is one of the top-K (by decayedWeight) valid reports of any pending/
   *  upheld state and so is subtracted in `scoreAtRisk`. */
  countedTowardRisk: boolean;
}

export interface EngineOutput {
  now: number;
  /** Final origin set (anchors ∪ Tier-2, converged) as of this computation. */
  origins: string[];
  /** BFS depth from the nearest origin, along active vouches. `Infinity` = unreachable within
   *  MAX_DEPTH. Anchors and Tier-2 origins are depth 0. */
  depth: Record<string, number>;
  /** Stage-1 positive human score s⁺, centi-points. Report-blind. */
  sPlus: Record<string, number>;
  /** Stage-2 platform score s_P, centi-points. */
  sPlatform: Record<string, number>;
  /** Stage-4 final human score, centi-points: upheld reports applied, floored. */
  score: Record<string, number>;
  /** Stage-4 at-risk human score, centi-points: upheld + pending reports applied, floored. */
  scoreAtRisk: Record<string, number>;
  /** Stage-5 tier, humans only. */
  tier: Record<string, Tier>;
  /** Stage-5 platform tier, platforms only. */
  platformTier: Record<string, PlatformTier>;
  /** Per-report weight/validity detail, keyed by report id — powers explain.ts. */
  reportWeights: Record<string, ReportWeightResult>;
}
