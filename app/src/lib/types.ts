/**
 * Types mirroring the shapes the real engine (`@aval/engine`, docs/07-app-api.md §5) and the
 * REST API (docs/07-app-api.md §3) will publish. Declared locally, by hand, so the app builds and
 * typechecks before that package exists. When it lands, everything in this file should be
 * replaced by `import type { ... } from "@aval/engine"` and the shapes should not need to change —
 * that is the point of writing them against the spec now instead of against a stub.
 */

export type Address = `0x${string}`;
export type EnsName = string;

export type AccountKind = "anchor" | "member" | "platform" | "agent";
/** Three distinct things, deliberately not collapsed:
 *  - "orb" — the FIXTURE's fictional demo anchor. Not real verification.
 *  - "genesis-testnet" — what `GenesisAnchorBook.anchorSource()` returns on World Chain Sepolia.
 *    A testnet stand-in for World ID's Address Book; nobody behind it was ever Orb-verified.
 *  - "world-id-orb" — World Chain MAINNET, where `AvalRegistry.addressBook` is World ID's real
 *    Address Book (0x57b930D5…0330D). Anchor status here IS genuine Orb verification.
 *  The UI must never conflate them (docs/07-app-api.md, contracts/script/GenesisAnchorBook.sol). */
export type AnchorSource = "orb" | "genesis-testnet" | "world-id-orb";

/** docs/01-trust-math.md §11 — T1 = 55, T2 = 140. The authoritative values are `@aval/engine`'s
 *  `T1` / `T2`; never retype them. */
export type Tier = 0 | 1 | 2;
export type PlatformTier = "P0" | "P1" | "P2";

export type CredentialStatus = "active" | "grace" | "suspended";
export type Credential = "orb" | "selfie" | "document";

/** docs/01-trust-math.md §11 — the four human promotion gates. */
export interface Gates {
  /** score >= T1 (55) / >= T2 (140) */
  g1ScoreThreshold: boolean;
  /** >= MIN_VOUCHERS distinct *contributing* inbound vouches — raw inbound edges do not count. */
  g2TwoDistinctVouchers: boolean;
  /** path of <= 3 active vouches to an origin exists */
  g3PathToOrigin: boolean;
  /** no upheld report in the last 90 days (Tier 2 only) */
  g4NoRecentUpheldReport: boolean;
}

export interface VoucherSummary {
  address: Address;
  ensName: EnsName;
  score: number;
  tier: Tier;
  depth: number | null;
  isAnchor: boolean;
  /** Set only when `isAnchor` — which provenance backs that anchor status. See `AnchorSource`. */
  anchorSource?: AnchorSource;
}

/** One row of the "visible arithmetic" on Home — docs/07-app-api.md §2.2. */
export interface VouchContribution {
  voucher: VoucherSummary;
  /** m+ = 0.25, always, until the day this is a dial */
  weight: number;
  /** min(voucher.score * weight, cap+ = 20) — 0 when `counted` is false */
  contribution: number;
  /** false when voucher depth is not strictly lower than the subject's depth (anti-collusion) */
  counted: boolean;
  /** plain-language reason shown next to a zero-contribution row */
  reason: string | null;
  issuedAt: string;
  expiresAt: string;
  daysUntilExpiry: number;
  expiringSoon: boolean;
}

/** "If Bob's vouch expires you drop to 22.5 and lose Tier 1." — docs/07-app-api.md §2.2. */
export interface WeakestLink {
  voucherEnsName: EnsName;
  contribution: number;
  scoreIfExpired: number;
  currentTier: Tier;
  tierIfExpired: Tier;
  losesTier: boolean;
  daysUntilExpiry: number;
}

export interface Slots {
  total: number;
  used: number;
  free: number;
}

/** docs/16-presence-drip.md §9 — the drip card and the tenure curve. */
export interface PresenceState {
  dailyRateAval: number;
  accruedAval: number;
  maxUnclaimedDays: number;
  daysUntilCap: number;
  presentDays: number;
  tenureBonus: number;
  tenureMaxBonus: number;
  /** 25 (tier 0) or 100 (tier 1+) — docs/16-presence-drip.md §3 */
  tierRatePct: number;
  /** tenure(E) sampled across the curve, centi-points, for the flattening chart */
  curve: Array<{ days: number; tenure: number }>;
}

export interface ScoreResult {
  address: Address;
  ensName: EnsName;
  kind: AccountKind;
  anchorSource?: AnchorSource;
  base: number;
  tenure: number;
  /** s+ — positive score before reports */
  positiveScore: number;
  /** final published score: max(base + tenure, s+ - upheld report weight) */
  score: number;
  /** score if pending reports were priced in too */
  scoreAtRisk: number;
  tier: Tier;
  depth: number | null;
  gates: Gates;
  breakdown: VouchContribution[];
  slots: Slots;
  weakestLink: WeakestLink | null;
  presence: PresenceState | null;
  credentialStatus: CredentialStatus;
  credentialExpiresAt: string;
}

export interface PlatformScoreResult {
  /** False when no platform exists on this graph — which, in live mode, is because
   *  PlatformRegistry is never read at all. The console renders "not read on this deployment"
   *  instead of a screen of zeros that reads as a measured result. */
  registered: boolean;
  address: Address;
  ensName: EnsName;
  score: number;
  tier: PlatformTier;
  voucherCount: number;
  /** `null` where the value has no source in this mode: the bond lives in CredibilityVault,
   *  request counts in the gateway, the upheld ratio in ReportRegistry — none of which the live
   *  reader touches. `null` renders as "not tracked"; it must never be flattened to 0. */
  bondAval: number | null;
  requestsLast30d: number | null;
  upheldRatePct: number | null;
  gates: { g1ScoreThreshold: boolean; g2TwoDistinctVouchers: boolean; g3BondPosted: boolean | null };
}

export type ReportStatus = "pending" | "upheld" | "rejected" | "decayed";

/** docs/12-reporting.md §3 — the challenge game. */
export interface ReportEntry {
  id: string;
  /** Relative to the SIGNED-IN viewer, not to the subject of whatever page renders it.
   *  "other" is load-bearing: `REPORTS` carries every report in the graph (so /profile can select
   *  by subject), and most of them involve neither the viewer nor anyone they know. */
  direction: "against" | "filed" | "other";
  reporter: { ensName: EnsName; kind: AccountKind; score: number };
  target: EnsName;
  status: ReportStatus;
  weight: number;
  filedAt: string;
  upheldAt: string | null;
  decayRemainingPct: number;
  challengeDeadline: string | null;
  reasonCode: string;
  /** The exact `ReportRegistry.State` this report is in on chain — PENDING, ARBITRATION, UPHELD,
   *  UNPROVEN, MALICIOUS or WITHDRAWN. `status` above is the engine's four-way reduction, in which
   *  UNPROVEN, MALICIOUS and WITHDRAWN all read as "rejected". They are different outcomes, so the
   *  screen shows this one when it exists. `null` in fixture mode, where no chain state exists to
   *  report. */
  onChainState: string | null;
  /** The transaction that filed the report. `null` off-chain. */
  txHash: string | null;
  /** AVAL the reporter bonded behind the accusation. `null` off-chain. */
  bondAval: number | null;
  /** Engine weight before §7.4 decay — `min(snapshotWeight, reporter score × m⁻, cap⁻)`. */
  baseWeight: number;
  /** False when the engine voids the report entirely (see `voidReason`). A voided report still
   *  exists on chain and is still shown; it just does not subtract anything from anyone. */
  valid: boolean;
  /** Why it was voided: `reporter_voided`, `platform_did_not_query_subject`, `report_withdrawn`, … */
  voidReason: string | null;
  /** True only if this report is among the top-3 upheld reports actually subtracted from `score`
   *  (docs/01-trust-math.md §7.3). A pending report is never counted here — an accusation is not a
   *  verdict — and no report is ever counted against an anchor. */
  countedTowardScore: boolean;
  /** The target's live published score and score-at-risk, so the effect line can state what this
   *  report ACTUALLY did rather than whether it was selected by the top-K cut. A report can be
   *  valid, counted and non-zero and still move neither number, because the engine floors the
   *  result at `base + tenure` — an accusation cannot reduce someone below the fact that they are
   *  a live human. Rendering "−10.0" beside an unchanged 20.0 is the failure this prevents. */
  targetScore: number;
  targetScoreAtRisk: number;
  /** The target's positive-only score, before any report is subtracted. `targetSPlus - targetScore`
   *  is the deduction that ACTUALLY landed; a report can be counted by the engine and still move
   *  nothing, because the result is floored at `base + tenure` and anchors ignore inbound edges. */
  targetSPlus: number;
  /** True if it is subtracted from `scoreAtRisk`, which prices pending accusations in. */
  countedTowardRisk: boolean;
}

export interface SimulateVouchStep {
  ensName: EnsName;
  before: number;
  after: number;
}

export interface SimulateVouchResult {
  voucher: EnsName;
  target: EnsName;
  targetBefore: { score: number; tier: Tier };
  targetAfter: { score: number; tier: Tier };
  promotes: boolean;
  voucherSlotsBefore: number;
  voucherSlotsAfter: number;
  nextVouchAvailableInHours: number;
  secondaryEffects: SimulateVouchStep[];
  /** Reasons this vouch would REVERT on chain, in the user's words. Empty means it can proceed.
   *
   *  `AvalRegistry.vouch()` reverts with `VouchExists()` if the edge is already active and
   *  `RateLimited()` within 24h of the voucher's last vouch. Checking both up front keeps the
   *  wizard from walking a user through a ~20s Selfie Check into a transaction that cannot
   *  succeed. Computed from live `members()` state, never assumed. */
  blockers: string[];
}

export interface PathHop {
  ensName: EnsName;
  address: Address;
  depth: number;
  contribution: number;
}
export interface PathResult {
  from: EnsName;
  to: EnsName;
  found: boolean;
  hops: PathHop[];
}

export interface CandidateVoucher {
  ensName: EnsName;
  address: Address;
  score: number;
  tier: Tier;
  mutualConnections: number;
  slotsFree: number;
}

export interface GatePolicy {
  minTier?: Tier;
  minScore?: number;
  usePendingReports?: boolean;
  requireCredential?: Credential;
}

export interface GateResult {
  allow: boolean;
  reasons: string[];
}

export interface IdentityResult {
  address: Address;
  ensName: EnsName;
  kind: AccountKind;
  registeredAt: string;
  credential: Credential;
  credentialStatus: CredentialStatus;
  anchorSource?: AnchorSource;
}

export interface HealthResult {
  status: "ok" | "degraded";
  subgraphDeployment: string;
  indexedBlock: number;
  chainHead: number;
  lagBlocks: number;
  /** LIVE mode only — the block AvalRegistry/GenesisAnchorBook/PresenceDrip were deployed at
   *  (deployments/worldchain-sepolia.json), so a viewer can see both "how current is this" and
   *  "how much history exists" at a glance. `undefined` in fixture mode, which has no real chain. */
  deploymentBlock?: number;
  chainId?: number;
}

/** docs/07-app-api.md §3 — carried on every response. */
export interface ApiMeta {
  subgraphDeployment: string;
  computedAtBlock: number;
  indexerLagBlocks: number;
  engineVersion: string;
  /** "live" reads World Chain Sepolia directly via viem; "fixture" is the static demo graph. */
  mode: "live" | "fixture";
  /** LIVE mode only. */
  chainId?: number;
  /** LIVE mode only — every deployed contract address in this set (docs/02-contracts.md), not
   *  only the ones this request happened to read. */
  contracts?: Record<string, string>;
}

export interface ApiEnvelope<T> {
  data: T;
  meta: ApiMeta;
}

export interface ApiErrorBody {
  error: { code: string; message: string };
  meta: ApiMeta;
}

/** docs/07-app-api.md §2.4 — honest path vs. collusion ring, both live, both at their real scores. */
export interface ExploreNode {
  ensName: EnsName;
  address: Address;
  kind: AccountKind;
  score: number;
  tier: Tier;
  depth: number | null;
  isAnchor: boolean;
  anchorSource?: AnchorSource;
}
export interface ExploreEdge {
  from: EnsName;
  to: EnsName;
  contribution: number;
  counted: boolean;
  reason: string | null;
}
export interface ExploreScenario {
  label: string;
  exhibit: string;
  description: string;
  /** False when this deployment's graph contains no such structure. The column then shows the
   *  reason and NOTHING else — no score, no tier, no narrative, since a scenario with zero nodes
   *  behind it must never print one anyway. */
  available: boolean;
  unavailableReason: string | null;
  nodes: ExploreNode[];
  edges: ExploreEdge[];
  finalScore: number;
  finalTier: Tier;
  gates: Gates;
}

/** docs/04-ens.md §4, docs/07-app-api.md §2.5 — agent subnames.
 *
 *  NOTHING in this record is published. There is no ENSIP-26/25 registrar call in this repo, and
 *  mcp.aval.xyz / a2a.aval.xyz / aval.xyz do not serve this app. `published` is false everywhere
 *  today; `exampleLabel` is the placeholder label the preview is composed with, and the UI must
 *  present it as an example rather than as a name the operator chose. */
export interface AgentRecord {
  published: boolean;
  exampleLabel: string;
  subname: EnsName;
  operator: EnsName;
  operatorScore: number;
  inheritedTier: Tier;
  endpointMcp: string;
  endpointA2a: string;
  ensip26: Record<string, string>;
  ensip25RegistrationKey: string;
}
