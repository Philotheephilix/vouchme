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

/** docs/01-trust-math.md §11 — T1 = 55, T2 = 140 (errata E-16 raised both with `base`). The
 *  authoritative values are `@aval/engine`'s `T1` / `T2`; never retype them. */
export type Tier = 0 | 1 | 2;
export type PlatformTier = "P0" | "P1" | "P2";

export type CredentialStatus = "active" | "grace" | "suspended";
export type Credential = "orb" | "selfie" | "document";

/** docs/01-trust-math.md §11 — the four human promotion gates. */
export interface Gates {
  /** score >= T1 (55) / >= T2 (140) — errata E-16 */
  g1ScoreThreshold: boolean;
  /** >= MIN_VOUCHERS distinct *contributing* inbound vouches — counting raw inbound edges here is
   *  the hole errata E-14 closed. */
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
  direction: "against" | "filed";
  reporter: { ensName: EnsName; kind: AccountKind; score: number };
  target: EnsName;
  status: ReportStatus;
  weight: number;
  filedAt: string;
  upheldAt: string | null;
  decayRemainingPct: number;
  challengeDeadline: string | null;
  reasonCode: string;
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
   *  `RateLimited()` within 24h of the voucher's last vouch. Neither was checked, so the wizard
   *  happily walked a user through a ~20s Selfie Check into a transaction that could not succeed
   *  (docs/94-acceptance.md P0-2). Computed from live `members()` state, never assumed. */
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
   *  reason and NOTHING else — no score, no tier, no narrative. A scenario with zero nodes that
   *  still prints "Six phones on a table" and a score is the exact defect this flag closes. */
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
