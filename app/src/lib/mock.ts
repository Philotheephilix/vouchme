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
 * the UI can't drift from the protocol: one scoring implementation, used everywhere.
 *
 * LIVE vs FIXTURE (task: "Wire the Aval mini app to the LIVE World Chain Sepolia deployment"):
 * the derivation logic below (`deriveAvalData`) is a single code path. What changes between modes
 * is only where the GRAPH comes from — `buildFixtureContext()` (this file, a static demo graph)
 * or `buildLiveContext()` (src/lib/chain.ts, real `Enrolled`/`Vouched`/`Reaffirmed`/`Revoked` logs
 * read live from AvalRegistry). Every number downstream of a `GraphContext` still flows through
 * `compute()` / `breakdown()` — there is no second path that formats raw chain data directly.
 */

import {
  ANCHOR,
  BASE,
  CAP_NEG,
  CAP_POS,
  GATE4_WINDOW_DAYS,
  MAX_DEPTH,
  MAX_UNCLAIMED_EPOCHS,
  MIN_VOUCHERS,
  M_POS_NUM,
  M_POS_DEN,
  P1,
  SECONDS_PER_DAY,
  SECONDS_PER_EPOCH,
  SLOTS_TIER_1,
  SLOTS_TIER_2,
  T1,
  T2,
  TIER_0_DRIP_RATE_PERCENT,
  TIER_1_PLUS_DRIP_RATE_PERCENT,
  T_MAX_CENTI,
  breakdown,
  compute,
} from "@aval/engine";
import type { Account, EngineInput, EngineOutput, PlatformVouch, Report, Vouch } from "@aval/engine";
import type {
  AccountKind,
  AgentRecord,
  ApiMeta,
  CandidateVoucher,
  Credential,
  CredentialStatus,
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
import type { Address, AnchorSource } from "./types";
import { centiToScore, tenureCurve, tenureFromDays } from "./format";
import {
  getAccruedDrip,
  getChainHealth,
  getChainMode,
  getContractAddressSet,
  getDemoAddress,
  getLiveGraph,
  WORLDCHAIN_ID,
} from "./chain";

// ─── the "now" the fixture is dated relative to; LIVE mode uses the latest block's own timestamp
// instead (src/lib/chain.ts `LiveGraph.now`), so every expiry/decay check is evaluated against a
// real, consistent point in chain time rather than the server's wall clock. ──────────────────────

const FIXTURE_NOW = new Date("2026-07-25T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const fixtureIso = (daysFromNow: number): string => new Date(FIXTURE_NOW.getTime() + daysFromNow * DAY_MS).toISOString();
/** The engine works in unix seconds, supplied by the caller (@aval/engine never reads a clock). */
const FIXTURE_GRAPH_NOW = Math.floor(FIXTURE_NOW.getTime() / 1000);

/** m+ = 0.25, for the "50.0 x 0.25" display line — imported from the engine's own constants
 *  rather than a hardcoded 0.25, so this can't drift from the real multiplier either. */
const DISPLAY_M_POS = M_POS_NUM / M_POS_DEN;

/** What enrollment alone buys you (docs/07-app-api.md §2.1) — `BASE`, tier 0. Pure engine
 *  constant, independent of graph source, so this stays a plain sync export in both modes. */
export const ENROLLMENT_BASE_SCORE = centiToScore(BASE);

/** An anchor's floor is NOT `BASE`: its score is fixed at `ANCHOR` and ignores every inbound edge
 *  (errata E-6). Printing `base 20.0` under a dial reading `100` — which is exactly what Home did
 *  for the one Orb-verified account on this deployment — is the U-3 defect all over again. */
export const ANCHOR_SCORE = centiToScore(ANCHOR);

/** Tier 1 threshold, in display points — used to *compute* the "what do I still need" copy instead
 *  of hardcoding a voucher count that stopped being true when `base`/`T1` moved (errata E-16). */
export const TIER_1_THRESHOLD_SCORE = centiToScore(T1);

/** What one vouch from an anchor is worth: min(100 × 0.25, cap⁺) = 20.00. Derived, not typed. */
export const ANCHOR_VOUCH_CONTRIBUTION = centiToScore(Math.min((ANCHOR * M_POS_NUM) / M_POS_DEN, CAP_POS));

/** `PresenceDrip.DRIP_NOMINAL` is 0.25 AVAL per 6h epoch, i.e. 1 AVAL/day at the full rate
 *  (contracts/src/PresenceDrip.sol §2). Derived from the epoch length rather than retyped. */
const NOMINAL_DRIP_AVAL_PER_EPOCH = 0.25;
const EPOCHS_PER_DAY = SECONDS_PER_DAY / SECONDS_PER_EPOCH;
const NOMINAL_DRIP_AVAL_PER_DAY = NOMINAL_DRIP_AVAL_PER_EPOCH * EPOCHS_PER_DAY;
const MAX_UNCLAIMED_DAYS = MAX_UNCLAIMED_EPOCHS / EPOCHS_PER_DAY;
const TENURE_MAX_BONUS = centiToScore(T_MAX_CENTI);

// ════════════════════════════════════════════════════════════════════════════════════════════
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

const FIXTURE_ME_ID = "carol.alice.aval.eth";
const HENRY_ID = "henry.aval.eth";
const IRIS_ID = "iris.aval.eth";
const FIXTURE_PLATFORM_ID = "marketpulse.aval.eth";

const RING_IDS = ["ring1.eth", "ring2.eth", "ring3.eth", "ring4.eth", "ring5.eth", "ring6.eth"];

const FIXTURE_ACCOUNTS: Account[] = [
  { id: "anchor1.aval.eth", kind: "human", isAnchor: true },
  { id: "anchor2.aval.eth", kind: "human", isAnchor: true },
  { id: "alice.aval.eth", kind: "human" },
  { id: "bob.aval.eth", kind: "human" },
  { id: HENRY_ID, kind: "human" },
  { id: IRIS_ID, kind: "human" },
  { id: FIXTURE_ME_ID, kind: "human" },
  { id: "dave.carol.aval.eth", kind: "human" },
  { id: "erin.carol.aval.eth", kind: "human" },
  { id: "grace.bob.aval.eth", kind: "human" },
  // docs/04-ens.md §1.2: names like this "resolve to nothing, because none of those labels descend
  // from aval.eth" — the ring is unrepresentable in the real namespace. Kept as flat mock ids here
  // only so the fixture graph has six distinct, clearly-labelled ring accounts to compute over.
  ...RING_IDS.map((id): Account => ({ id, kind: "human" })),
  { id: FIXTURE_PLATFORM_ID, kind: "platform" },
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
  mkVouch("alice.aval.eth", FIXTURE_ME_ID),
  mkVouch("bob.aval.eth", FIXTURE_ME_ID),
  mkVouch(FIXTURE_ME_ID, "dave.carol.aval.eth"),
  mkVouch("dave.carol.aval.eth", FIXTURE_ME_ID), // reciprocal — zero-contribution row
  mkVouch(FIXTURE_ME_ID, "erin.carol.aval.eth"),
  mkVouch("bob.aval.eth", "grace.bob.aval.eth"),
];

const RING_VOUCHES: Vouch[] = RING_IDS.flatMap((src) =>
  RING_IDS.filter((dst) => dst !== src).map((dst) => mkVouch(src, dst)),
);

const FIXTURE_VOUCHES: Vouch[] = [...CORE_VOUCHES, ...RING_VOUCHES];

const FIXTURE_PLATFORM_VOUCHES: PlatformVouch[] = ["alice.aval.eth", "bob.aval.eth", HENRY_ID, IRIS_ID].map(
  (voucher): PlatformVouch => ({ voucher, platform: FIXTURE_PLATFORM_ID, active: true }),
);

const OLD_UPHELD_AGO_DAYS = 185; // past the 180-day decay window (docs/01-trust-math.md §7.4)

// docs/12-reporting.md §3, docs/01-trust-math.md §7 — real reports fed through the real engine, so
// weight/decay/void-reason are computed the same way a live report would be, not approximated by a
// standalone formula. `snapshotWeight: CAP_NEG` for all three: none of these illustrative reports
// are meant to demonstrate the R-1 bonded-snapshot cap itself (that's covered by the engine's own
// tests), so the snapshot is set to the max, making weight = min(live, cap) exactly as it would be
// for an ordinary report that hasn't hit its bond ceiling.
const FIXTURE_REPORTS: Report[] = [
  {
    id: "rpt_pending_henry",
    reporter: HENRY_ID,
    target: FIXTURE_ME_ID,
    state: "pending",
    snapshotWeight: CAP_NEG,
  },
  {
    id: "rpt_decayed_anchor2",
    reporter: "anchor2.aval.eth",
    target: FIXTURE_ME_ID,
    state: "upheld",
    upheldAt: FIXTURE_GRAPH_NOW - OLD_UPHELD_AGO_DAYS * SECONDS_PER_DAY,
    snapshotWeight: CAP_NEG,
  },
  {
    id: "rpt_upheld_filed_by_me",
    reporter: FIXTURE_ME_ID,
    target: RING_IDS[0]!,
    state: "upheld",
    upheldAt: FIXTURE_GRAPH_NOW - 45 * SECONDS_PER_DAY,
    snapshotWeight: CAP_NEG,
  },
];

const REPORT_DISPLAY_META: Record<string, { filedAgoDays: number; reasonCode: string; challengeWindowHours: number | null }> = {
  rpt_pending_henry: { filedAgoDays: 1, reasonCode: "SUSPECTED_SYBIL", challengeWindowHours: 72 },
  rpt_decayed_anchor2: { filedAgoDays: OLD_UPHELD_AGO_DAYS + 3, reasonCode: "MISREPRESENTED_AFFILIATION", challengeWindowHours: null },
  rpt_upheld_filed_by_me: { filedAgoDays: 48, reasonCode: "COLLUSION_RING", challengeWindowHours: null },
};

interface DirectoryEntry {
  id: string;
  kind: AccountKind;
  credential: Credential;
  registeredAgoDays: number;
}

const FIXTURE_DIRECTORY: DirectoryEntry[] = [
  { id: "anchor1.aval.eth", kind: "anchor", credential: "orb", registeredAgoDays: 400 },
  { id: "anchor2.aval.eth", kind: "anchor", credential: "orb", registeredAgoDays: 380 },
  { id: "alice.aval.eth", kind: "member", credential: "selfie", registeredAgoDays: 200 },
  { id: "bob.aval.eth", kind: "member", credential: "selfie", registeredAgoDays: 190 },
  { id: FIXTURE_ME_ID, kind: "member", credential: "selfie", registeredAgoDays: 214 },
  { id: "dave.carol.aval.eth", kind: "member", credential: "selfie", registeredAgoDays: 5 },
  { id: "erin.carol.aval.eth", kind: "member", credential: "selfie", registeredAgoDays: 5 },
  { id: "grace.bob.aval.eth", kind: "member", credential: "selfie", registeredAgoDays: 60 },
  { id: FIXTURE_PLATFORM_ID, kind: "platform", credential: "document", registeredAgoDays: 120 },
];

/** Deterministic fake address so every fixture identity has one, without a real keystore. */
function fixtureAddressFor(ensName: string): Address {
  let h = 0;
  for (let i = 0; i < ensName.length; i++) h = (h * 31 + ensName.charCodeAt(i)) >>> 0;
  const hex = h.toString(16).padStart(8, "0");
  return `0x${hex.repeat(5).slice(0, 40)}`;
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// ─── GraphContext — the one seam between "where the graph comes from" and "how it's displayed" ──

/** Real (live) or synthetic (fixture) issue/expiry timing for one inbound vouch row. */
interface EdgeTiming {
  issuedAt: string;
  expiresAt: string;
  daysUntilExpiry: number;
}

interface ReportDisplayMeta {
  /** Unix seconds. Live: `ReportRegistry.reports(id).filedAt`, the chain's own clock. Fixture:
   *  derived from the authored `filedAgoDays`. Previously live mode passed `now` here, which made
   *  every real report claim it had been filed this second. */
  filedAt: number;
  /** Free-text, and in live mode NEVER a category: `ReportRegistry` stores an `evidenceHash`, not
   *  a reason code, so the live value describes the evidence that exists (or says none does).
   *  Inventing "SUSPECTED_SYBIL" for a real accusation would be putting words in a reporter's
   *  mouth. */
  reasonCode: string;
  challengeWindowHours: number | null;
  /** The exact `ReportRegistry.State` name (PENDING / ARBITRATION / UPHELD / UNPROVEN / MALICIOUS /
   *  WITHDRAWN). The engine collapses seven states into four, and UNPROVEN vs MALICIOUS vs
   *  WITHDRAWN are three genuinely different things (errata E-12) that all render as "rejected"
   *  without this. `null` in fixture mode, which has no chain to have a state on. */
  onChainState: string | null;
  /** `bytes32(0)` when the reporter attached no evidence. `null` off-chain. */
  evidenceHash: string | null;
  /** The transaction that filed it — the receipt a person can actually verify. */
  txHash: string | null;
  /** AVAL bonded behind the accusation, `10 × weightPoints` (docs/12-reporting.md §3). */
  bondAval: number | null;
}

interface GraphContext {
  mode: "live" | "fixture";
  meta: ApiMeta;
  now: Date;
  graphNow: number;
  meId: string;
  accounts: Account[];
  vouches: Vouch[];
  platformVouches: PlatformVouch[];
  reports: Report[];
  addressFor: (id: string) => Address;
  ensNameFor: (id: string) => string;
  anchorSourceFor: (id: string) => AnchorSource | undefined;
  /** What backs anchor status on THIS graph, independent of whether any anchor is present.
   *  Live mode reads it off the configured Address Book (`chain.ts` `getAnchorSource`), so prose
   *  about anchors can't call a mainnet Orb anchor "genesis (testnet)" — which is exactly what
   *  /explore printed on World Chain mainnet. */
  graphAnchorSource: AnchorSource;
  /** False when this graph source never asks the chain about reports / platforms at all — the
   *  live reader builds its `EngineInput` with `reports: []` and `platformVouches: []`
   *  (`chain.ts`). An empty list is then "we didn't look", NOT "there are none", and any screen
   *  built on it has to say which. */
  reportsAvailable: boolean;
  platformsAvailable: boolean;
  edgeTiming: (voucherId: string, voucheeId: string) => EdgeTiming;
  /** Which counted inbound voucher of `meId` is its "weakest link" for the Home-screen warning.
   *  Fixture pins this to the authored narrative ("bob"); live mode picks the counted voucher
   *  closest to real expiry — both flow through the same generic recompute in `deriveAvalData`. */
  weakestLinkVoucherId: (countedVoucherIds: string[]) => string | null;
  slotsFor: (id: string, tier: Tier) => Slots;
  /** Unix seconds of `id`'s last `vouch()`, or 0 if never / unknown. `AvalRegistry` reverts with
   *  `RateLimited()` inside 24h of it, so the vouch preview needs it to refuse a doomed vouch
   *  instead of walking the user into one. Fixture mode has no such state and returns 0. */
  lastVouchAtFor: (id: string) => number;
  credentialFor: (id: string) => { status: CredentialStatus; expiresAt: string; credential: Credential };
  /** Prospective vouchers for `id`: real enrolled humans, tier >= 1, not `id` itself, not already
   *  vouching `id`, sorted best-first. Generalized off any id (task correction: "Home ... signed
   *  in user's own"), not hardcoded to `meId`. */
  candidatesFor: (id: string) => string[];
  /** `null` when no platform exists in this graph (true of the live deployment — nobody has
   *  registered one yet). The platform screen renders the honest empty state in that case. */
  platformId: string | null;
  /** AVAL the platform has bonded, or `null` if unknown. Live mode reads it from
   *  `PlatformRegistry.platforms(addr).bond` — the registry custodies platform bonds itself rather
   *  than routing them through `CredibilityVault` (PlatformRegistry.sol's own NOTE(deviation) 1),
   *  so this is a real number now, not the unread one the /platform screen used to print as null. */
  platformBondAval: (id: string) => number | null;
  /** The facts about a report that the ENGINE deliberately does not model — when it was filed,
   *  which of the seven on-chain states it is actually in, what evidence was attached, and which
   *  transaction filed it. The engine reduces a report to `{state, upheldAt, snapshotWeight}`
   *  because that is all the math needs; a screen that has to tell a person what happened to them
   *  needs the rest, and it must come from the chain rather than from this module's imagination. */
  reportDisplayMeta: (reportId: string) => ReportDisplayMeta;
  directory: DirectoryEntry[];
  /** Real `PresenceDrip` state for `id`. `accruedAval` is only ever non-zero for the address
   *  actually being viewed this request (one live `accrued()` read, not one per account — see
   *  `buildLiveContext`) since claiming only ever applies to the signed-in viewer. */
  presenceFor: (id: string) => { epochsClaimed: number; accruedAval: number };
  isEnrolledId: (id: string) => boolean;
  /** True when this render is for a signed-in wallet's own data (cookie-sourced address passed to
   *  `loadAvalData`), false when it fell back to the `ME_ADDRESS` demo identity because nobody is
   *  signed in. Drives the "viewing carol — sign in to see your own" banner. */
  viewerIsSelf: boolean;
}

function buildFixtureContext(): GraphContext {
  const edgeDays: Record<string, { issuedAgoDays: number; expiresInDays: number }> = {
    [`alice.aval.eth::${FIXTURE_ME_ID}`]: { issuedAgoDays: 16, expiresInDays: 74 },
    [`bob.aval.eth::${FIXTURE_ME_ID}`]: { issuedAgoDays: 72, expiresInDays: 18 },
    [`dave.carol.aval.eth::${FIXTURE_ME_ID}`]: { issuedAgoDays: 5, expiresInDays: 85 },
  };
  let genericIndex = 0;

  return {
    mode: "fixture",
    meta: {
      subgraphDeployment: "QmXoT9auAvEZuwVUXCoAxzuUxKG1nGbXCn6UhtqrBQqLA5",
      computedAtBlock: 8_214_552,
      indexerLagBlocks: 2,
      engineVersion: "0.1.0",
      mode: "fixture",
    },
    now: FIXTURE_NOW,
    graphNow: FIXTURE_GRAPH_NOW,
    meId: FIXTURE_ME_ID,
    accounts: FIXTURE_ACCOUNTS,
    vouches: FIXTURE_VOUCHES,
    platformVouches: FIXTURE_PLATFORM_VOUCHES,
    reports: FIXTURE_REPORTS,
    addressFor: fixtureAddressFor,
    ensNameFor: (id) => id,
    anchorSourceFor: (id) => (FIXTURE_ACCOUNTS.find((a) => a.id === id)?.isAnchor ? "orb" : undefined),
    graphAnchorSource: "orb",
    reportsAvailable: true,
    platformsAvailable: true,
    edgeTiming: (voucherId, voucheeId) => {
      const known = edgeDays[`${voucherId}::${voucheeId}`];
      const { issuedAgoDays, expiresInDays } = known ?? { issuedAgoDays: 10 + ((genericIndex++ * 17) % 60), expiresInDays: 0 };
      const expires = known ? expiresInDays : 90 - issuedAgoDays;
      return { issuedAt: fixtureIso(-issuedAgoDays), expiresAt: fixtureIso(expires), daysUntilExpiry: expires };
    },
    weakestLinkVoucherId: () => "bob.aval.eth",
    // Tier-derived and counted off the fixture's own edges, so an anchor with four outbound
    // vouches never renders "0 of 10 free" (or, as it used to for anchors, a flat literal that
    // ignored the vouches it had actually issued).
    slotsFor: (id, tier) => {
      const total = tier >= 2 ? SLOTS_TIER_2 : tier >= 1 ? SLOTS_TIER_1 : 0;
      const used = Math.min(total, FIXTURE_VOUCHES.filter((v) => v.voucher === id && v.active).length);
      return { total, used, free: total - used };
    },
    // The fixture graph has no rate-limit state — it is an authored narrative, not chain history.
    lastVouchAtFor: () => 0,
    credentialFor: () => ({ status: "active", expiresAt: fixtureIso(60), credential: "selfie" }),
    candidatesFor: (id) => (id === FIXTURE_ME_ID ? ["grace.bob.aval.eth", HENRY_ID] : []),
    platformId: FIXTURE_PLATFORM_ID,
    platformBondAval: () => 5_200,
    reportDisplayMeta: (id) => {
      const m = REPORT_DISPLAY_META[id] ?? { filedAgoDays: 0, reasonCode: "UNKNOWN", challengeWindowHours: null };
      return {
        filedAt: FIXTURE_GRAPH_NOW - m.filedAgoDays * SECONDS_PER_DAY,
        reasonCode: m.reasonCode,
        challengeWindowHours: m.challengeWindowHours,
        // A fixture report was never filed on any chain, so it has no state, no evidence and no
        // transaction. `null` says that; a plausible-looking hash would not.
        onChainState: null,
        evidenceHash: null,
        txHash: null,
        bondAval: null,
      };
    },
    directory: FIXTURE_DIRECTORY,
    // 214 days present (docs/16-presence-drip.md §9 demo panel) — authored only for the fixture's
    // one narrative identity; every other id honestly has no presence authored, so it's zero.
    presenceFor: (id) => (id === FIXTURE_ME_ID ? { epochsClaimed: 856, accruedAval: 14.5 } : { epochsClaimed: 0, accruedAval: 0 }),
    isEnrolledId: (id) => FIXTURE_ACCOUNTS.some((a) => a.id === id),
    viewerIsSelf: false,
  };
}

function pairKey(voucher: string, vouchee: string): string {
  return `${voucher.toLowerCase()}::${vouchee.toLowerCase()}`;
}

async function buildLiveContext(viewingAddress?: Address): Promise<GraphContext> {
  const graph = await getLiveGraph();
  // Task correction: "Delete ME_ADDRESS as the source of 'me'." `ME_ADDRESS` now only fires as a
  // read-only demo fallback when nobody is signed in (`viewingAddress` undefined — no cookie).
  const meAddress = viewingAddress ?? getDemoAddress();
  const meId = meAddress; // chain.ts uses the checksummed address as the account id
  const viewerIsSelf = viewingAddress !== undefined;

  const nowSeconds = graph.now;
  const nowDate = new Date(nowSeconds * 1000);

  const ensNameFor = (id: string): string => graph.ensNameFor.get(id as Address) ?? id;

  const anchorSourceFor = (id: string): AnchorSource | undefined => {
    const acc = graph.engineInput.accounts.find((a) => a.id === id);
    return acc?.isAnchor ? graph.anchorSource : undefined;
  };

  const edgeTiming = (voucherId: string, voucheeId: string): EdgeTiming => {
    const meta = graph.vouchMeta.get(pairKey(voucherId, voucheeId));
    if (!meta) {
      // Shouldn't happen for an edge the engine itself reported as inbound, but stay honest
      // rather than fabricate a date if it ever does.
      return { issuedAt: nowDate.toISOString(), expiresAt: nowDate.toISOString(), daysUntilExpiry: 0 };
    }
    const daysUntilExpiry = (meta.expiresAt - nowSeconds) / SECONDS_PER_DAY;
    return {
      issuedAt: new Date(meta.issuedAt * 1000).toISOString(),
      expiresAt: new Date(meta.expiresAt * 1000).toISOString(),
      daysUntilExpiry,
    };
  };

  // Weakest link, generalized: the counted inbound voucher soonest to really expire. If several
  // are tied, or none are counted, this still resolves deterministically (Array.reduce over a
  // stable input order).
  const weakestLinkVoucherId = (countedVoucherIds: string[]): string | null => {
    if (countedVoucherIds.length === 0) return null;
    let best = countedVoucherIds[0]!;
    let bestExpiry = graph.vouchMeta.get(pairKey(best, meId))?.expiresAt ?? Number.POSITIVE_INFINITY;
    for (const id of countedVoucherIds.slice(1)) {
      const exp = graph.vouchMeta.get(pairKey(id, meId))?.expiresAt ?? Number.POSITIVE_INFINITY;
      if (exp < bestExpiry) {
        best = id;
        bestExpiry = exp;
      }
    }
    return best;
  };

  const tierOfLive = (id: string): Tier => (graph.engineOutput.tier[id] ?? 0) as Tier;

  const slotsFor = (id: string, tierArg?: Tier): Slots => {
    const t = tierArg ?? tierOfLive(id);
    const total = t >= 2 ? SLOTS_TIER_2 : t >= 1 ? SLOTS_TIER_1 : 0;
    const used = Math.min(total, graph.members.get(id as Address)?.activeOutbound ?? 0);
    return { total, used, free: total - used };
  };

  /** Anchor status on this deployment IS an Orb verification, read live from World ID's Address
   *  Book (errata E-18). Reporting every account's credential as "selfie" therefore said something
   *  false about the accounts the protocol is grounded on. Non-anchors really are selfie-check
   *  enrollments — that is the only credential `/api/enroll` ever attests. */
  const credentialKindFor = (id: string): Credential =>
    graph.engineInput.accounts.find((a) => a.id === id)?.isAnchor ? "orb" : "selfie";

  const credentialFor = (id: string): { status: CredentialStatus; expiresAt: string; credential: Credential } => {
    const m = graph.members.get(id as Address);
    const expiresAt = m ? new Date(m.credentialExpiresAt * 1000).toISOString() : nowDate.toISOString();
    const graceEndsAt = (m?.credentialExpiresAt ?? 0) + 14 * SECONDS_PER_DAY;
    const status: CredentialStatus = !m
      ? "active"
      : nowSeconds <= m.credentialExpiresAt
        ? "active"
        : nowSeconds <= graceEndsAt
          ? "grace"
          : "suspended";
    return { status, expiresAt, credential: credentialKindFor(id) };
  };

  // Prospective vouchers for any id: real enrolled humans, computed tier >= 1 (FR-3: tier 0
  // cannot vouch), not the target itself, and not already actively vouching it — sorted by real
  // score, best first. Generalized off `id` (was hardcoded to `meId`) so any signed-in viewer, not
  // only the demo identity, gets a real candidate list.
  const candidatesFor = (targetId: string): string[] => {
    const alreadyVouching = new Set(
      graph.engineInput.vouches.filter((v) => v.active && v.vouchee === targetId).map((v) => v.voucher),
    );
    return graph.engineInput.accounts
      .filter((a) => a.id !== targetId && tierOfLive(a.id) >= 1 && !alreadyVouching.has(a.id))
      .sort((a, b) => (graph.engineOutput.score[b.id] ?? 0) - (graph.engineOutput.score[a.id] ?? 0))
      .map((a) => a.id);
  };

  const directory: DirectoryEntry[] = graph.engineInput.accounts.map((a) => {
    const m = graph.members.get(a.id as Address);
    const registeredAgoDays = m ? Math.max(0, (nowSeconds - m.enrolledAt) / SECONDS_PER_DAY) : 0;
    return {
      id: a.id,
      kind: a.isAnchor ? "anchor" : "member",
      credential: credentialKindFor(a.id),
      registeredAgoDays,
    };
  });

  // Real accrued AVAL, but only for the identity actually being viewed this request — one
  // `PresenceDrip.accrued()` read (docs/16-presence-drip.md §9's "Claim button ... updates the
  // accrued figure"), not one per account in the graph (that would be exactly the N-account
  // fan-out the Multicall3 batch config exists to avoid).
  const accruedWei = await getAccruedDrip(meAddress);
  const accruedAvalForViewed = Number(accruedWei) / 1e18;

  const presenceFor = (id: string): { epochsClaimed: number; accruedAval: number } => {
    const p = graph.presence.get(id as Address);
    return { epochsClaimed: p?.epochsClaimed ?? 0, accruedAval: id === meAddress ? accruedAvalForViewed : 0 };
  };

  const isEnrolledId = (id: string): boolean => graph.members.get(id as Address)?.enrolled ?? false;

  /** The 72-hour challenge window is the only window that starts at `filedAt`
   *  (`ReportRegistry.CHALLENGE_WINDOW`). Arbitration's 7 days start when `resolve()` escalated,
   *  not when the report was filed, so offering a "filedAt + 7d" deadline for an ARBITRATION
   *  report would be a countdown to the wrong moment — `onChainState` carries that case instead. */
  const CHALLENGE_WINDOW_HOURS = 72;

  const ZERO_EVIDENCE = `0x${"0".repeat(64)}`;

  const reportDisplayMeta = (reportId: string): ReportDisplayMeta => {
    const m = graph.reportMeta.get(reportId);
    if (!m) {
      // A report id the engine scored but chain.ts has no record of cannot happen (the engine's
      // report list is built FROM that record), so rather than invent a filing date, say nothing.
      return {
        filedAt: nowSeconds,
        reasonCode: "UNKNOWN",
        challengeWindowHours: null,
        onChainState: null,
        evidenceHash: null,
        txHash: null,
        bondAval: null,
      };
    }
    return {
      filedAt: m.filedAt,
      // ReportRegistry stores evidence, not a reason. Say which of the two we have.
      reasonCode: m.evidenceHash === ZERO_EVIDENCE ? "no evidence attached" : `evidence ${m.evidenceHash.slice(0, 10)}…`,
      challengeWindowHours: m.state === "PENDING" ? CHALLENGE_WINDOW_HOURS : null,
      onChainState: m.state,
      evidenceHash: m.evidenceHash,
      txHash: m.txHash,
      bondAval: Number(m.bond / BigInt(10) ** BigInt(14)) / 10_000,
    };
  };

  return {
    mode: "live",
    meta: {
      subgraphDeployment: `direct-chain-read:${WORLDCHAIN_ID}`,
      computedAtBlock: Number(graph.block),
      indexerLagBlocks: 0, // no separate indexer in live mode — this app reads AvalRegistry directly
      engineVersion: "0.1.0",
      mode: "live",
      chainId: WORLDCHAIN_ID,
      contracts: getContractAddressSet(),
    },
    now: nowDate,
    graphNow: nowSeconds,
    meId,
    accounts: graph.engineInput.accounts,
    vouches: graph.engineInput.vouches,
    platformVouches: graph.engineInput.platformVouches,
    reports: graph.engineInput.reports,
    addressFor: (id) => id as Address,
    ensNameFor,
    anchorSourceFor,
    graphAnchorSource: graph.anchorSource,
    // Both now come from `chain.ts`, which scans ReportRegistry / PlatformRegistry when they are
    // configured. `false` still means exactly what it always meant — "this deployment does not
    // read that registry, so an empty list is not evidence of anything" — but it is now a fact
    // about the configuration rather than a hardcoded admission.
    reportsAvailable: graph.reportsAvailable,
    platformsAvailable: graph.platformsAvailable,
    edgeTiming,
    weakestLinkVoucherId,
    slotsFor,
    lastVouchAtFor: (id) => graph.members.get(id as Address)?.lastVouchAt ?? 0,
    credentialFor,
    candidatesFor,
    // The first ACTIVE registered platform, or null if none is registered. One platform is all the
    // /platform screen can show; `platformsAvailable` above is what distinguishes "none registered"
    // from "never asked".
    platformId: [...graph.platforms.values()].find((p) => p.active)?.address ?? null,
    platformBondAval: (id) => {
      const p = graph.platforms.get(id as Address);
      return p ? Number(p.bond / BigInt(10) ** BigInt(14)) / 10_000 : null;
    },
    reportDisplayMeta,
    directory,
    presenceFor,
    isEnrolledId,
    viewerIsSelf,
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// ─── shared derivation — the single code path both modes flow through ───────────────────────────

export interface AvalData {
  mode: "live" | "fixture";
  meta: ApiMeta;
  /** See `GraphContext.reportsAvailable` / `.platformsAvailable`: false means this graph source
   *  never queried that registry, so `REPORTS` / `PLATFORM` being empty is not evidence of
   *  anything. `/reports` and `/platform` render an explicit "not read on this deployment" state
   *  rather than an empty list that reads as a clean bill of health. */
  reportsAvailable: boolean;
  platformsAvailable: boolean;
  /** True when `ME` is the signed-in viewer's own data; false when nobody is signed in and this
   *  fell back to the read-only `ME_ADDRESS` demo identity (task correction §1). */
  viewerIsSelf: boolean;
  ME: ScoreResult;
  PLATFORM: PlatformScoreResult;
  REPORTS: ReportEntry[];
  AGENT: AgentRecord;
  EXPLORE_HONEST: ExploreScenario;
  EXPLORE_RING: ExploreScenario;
  HEALTH: HealthResult;
  CANDIDATES: CandidateVoucher[];
  VOUCH_SIMULATION: SimulateVouchResult;
  NOW: Date;
  getScoreResult: (idOrAddress: string) => ScoreResult | undefined;
  getCandidates: (idOrAddress: string) => CandidateVoucher[] | undefined;
  isEnrolled: (idOrAddress: string) => boolean;
  explainProse: (idOrAddress: string) => string | undefined;
  findIdentity: (idOrAddress: string) => IdentityResult | undefined;
  checkGate: (idOrAddress: string, policy: GatePolicy) => GateResult;
  findPath: (fromEnsName: string, toEnsName: string) => PathResult;
  simulateVouch: (voucherId: string, targetId: string) => SimulateVouchResult;
}

function deriveAvalData(ctx: GraphContext): AvalData {
  const engineInput: EngineInput = {
    now: ctx.graphNow,
    accounts: ctx.accounts,
    vouches: ctx.vouches,
    platformVouches: ctx.platformVouches,
    reports: ctx.reports,
  };
  const result: EngineOutput = compute(engineInput);

  function humanScore(id: string): number {
    return centiToScore(result.score[id] ?? BASE);
  }
  function humanSPlus(id: string): number {
    return centiToScore(result.sPlus[id] ?? BASE);
  }
  function humanScoreAtRisk(id: string): number {
    return centiToScore(result.scoreAtRisk[id] ?? BASE);
  }
  function depthOf(id: string): number | null {
    const d = result.depth[id];
    return d !== undefined && Number.isFinite(d) ? d : null;
  }
  function tierOf(id: string): Tier {
    return (result.tier[id] ?? 0) as Tier;
  }
  function isAnchorId(id: string): boolean {
    return ctx.accounts.find((a) => a.id === id)?.isAnchor ?? false;
  }
  /** An anchor's floor is `ANCHOR` (100.00), not `BASE` — errata E-6. This used to be two separate
   *  literals: `ENROLLMENT_BASE_SCORE` for `ME` (so Home printed `base 20.0 + 0.0 = 20.0` under a
   *  dial reading `100` for the Orb-verified account on this deployment) and a hardcoded
   *  `acc.isAnchor ? 100.0 : 10.0` in `getScoreResult` (whose `10.0` had been stale since
   *  errata E-16 raised `base` to 20). One derivation now, for every caller. */
  function baseScoreFor(id: string): number {
    return isAnchorId(id) ? ANCHOR_SCORE : ENROLLMENT_BASE_SCORE;
  }
  function platformTierFromEngine(t: number | undefined): "P0" | "P1" | "P2" {
    return (t ?? 0) >= 2 ? "P2" : (t ?? 0) >= 1 ? "P1" : "P0";
  }

  const breakdownCache = new Map<string, ReturnType<typeof breakdown>>();
  function breakdownFor(id: string): ReturnType<typeof breakdown> {
    let bd = breakdownCache.get(id);
    if (!bd) {
      bd = breakdown(id, engineInput, result);
      breakdownCache.set(id, bd);
    }
    return bd;
  }

  /** No engine-exposed equivalent: `EngineOutput` publishes tiers, not the individual gate
   *  booleans that fed them. Mirrors the engine's own internal check purely over already-public
   *  data (`ctx.reports` + `ctx.graphNow`), for display only. */
  function hasRecentUpheldReportAgainst(id: string): boolean {
    return ctx.reports.some(
      (r) =>
        r.target === id &&
        r.state === "upheld" &&
        r.upheldAt !== undefined &&
        ctx.graphNow - r.upheldAt < GATE4_WINDOW_DAYS * SECONDS_PER_DAY &&
        ctx.graphNow - r.upheldAt >= 0,
    );
  }

  /** Gate 2 here is derived from `breakdown()`'s own `counted` flag — the exact same corrected,
   *  depth-ordered definition the real engine's gate 2 uses (R-8) — not re-counted independently. */
  function gatesFor(id: string): Gates {
    const bd = breakdownFor(id);
    const distinctCounted = new Set(bd.vouchers.filter((v) => v.counted).map((v) => v.voucher)).size;
    const d = result.depth[id];
    const scoreCenti = result.score[id] ?? BASE;
    return {
      g1ScoreThreshold: scoreCenti >= T1,
      g2TwoDistinctVouchers: distinctCounted >= MIN_VOUCHERS,
      g3PathToOrigin: d !== undefined && Number.isFinite(d) && d <= MAX_DEPTH,
      g4NoRecentUpheldReport: !hasRecentUpheldReportAgainst(id),
    };
  }

  function voucherSummary(id: string): VoucherSummary {
    const acc = ctx.accounts.find((a) => a.id === id);
    return {
      address: ctx.addressFor(id),
      ensName: ctx.ensNameFor(id),
      score: humanScore(id),
      tier: tierOf(id),
      depth: depthOf(id),
      isAnchor: acc?.isAnchor ?? false,
      anchorSource: acc?.isAnchor ? ctx.anchorSourceFor(id) : undefined,
    };
  }

  function displayLabel(id: string): string {
    const [first] = ctx.ensNameFor(id).split(".");
    return first ? first[0]!.toUpperCase() + first.slice(1) : ctx.ensNameFor(id);
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

  function contributionRowFromEngine(row: EngineVoucherRow, timing: EdgeTiming): VouchContribution {
    return {
      voucher: voucherSummary(row.voucher),
      weight: DISPLAY_M_POS,
      contribution: centiToScore(row.contribution),
      counted: row.counted,
      reason: voucherReasonText(row),
      issuedAt: timing.issuedAt,
      expiresAt: timing.expiresAt,
      daysUntilExpiry: timing.daysUntilExpiry,
      expiringSoon: timing.daysUntilExpiry <= 21,
    };
  }

  function genericBreakdown(id: string): VouchContribution[] {
    return breakdownFor(id).vouchers.map((row) => contributionRowFromEngine(row, ctx.edgeTiming(row.voucher, id)));
  }

  // ─── weakest link / presence — generalized off any id, not hardcoded to `meId` (task
  // correction: Home must show the signed-in viewer's own data, and `/api/score/[address]` must
  // return real values for any address, not `null` placeholders once you're not "ME"). ──────────

  function weakestLinkForId(id: string, tier: Tier, bd: ReturnType<typeof breakdown>, displayBreakdown: VouchContribution[]): ScoreResult["weakestLink"] {
    const countedIds = bd.vouchers.filter((v) => v.counted).map((v) => v.voucher);
    const weakestId = ctx.weakestLinkVoucherId(countedIds);
    if (!weakestId) return null;
    const withoutIt: Vouch[] = ctx.vouches.map((v) => (v.voucher === weakestId && v.vouchee === id ? { ...v, active: false } : v));
    const resultWithout = compute({ ...engineInput, vouches: withoutIt });
    const scoreIfExpired = centiToScore(resultWithout.score[id] ?? BASE);
    const tierIfExpired = (resultWithout.tier[id] ?? 0) as Tier;
    const row = displayBreakdown.find((r) => r.voucher.ensName === ctx.ensNameFor(weakestId));
    return {
      voucherEnsName: ctx.ensNameFor(weakestId),
      contribution: row?.contribution ?? 0,
      scoreIfExpired,
      currentTier: tier,
      tierIfExpired,
      losesTier: tierIfExpired < tier,
      daysUntilExpiry: row?.daysUntilExpiry ?? 0,
    };
  }

  function presenceStateForId(id: string, tier: Tier): PresenceState {
    const p = ctx.presenceFor(id);
    const presentDays = p.epochsClaimed / EPOCHS_PER_DAY;
    // Engine constants, not retyped percentages (docs/16-presence-drip.md §3).
    const tierRatePct = tier >= 1 ? TIER_1_PLUS_DRIP_RATE_PERCENT : TIER_0_DRIP_RATE_PERCENT;
    const dailyRateAval = (NOMINAL_DRIP_AVAL_PER_DAY * tierRatePct) / 100;
    // `PresenceDrip.accrued()` is deliberately NOMINAL and tier-blind — it counts epochs, and the
    // tier discount is applied inside `claim()` (contracts/src/PresenceDrip.sol NOTE(deviation) 2).
    // Rendering the raw figure under the words "accrued, unclaimed" next to a "25% rate" badge
    // therefore overstated a Tier 0 account's claimable balance by 4x. Show what `claim()` would
    // actually mint; keep the nominal figure for the cap countdown, which IS tier-blind.
    const nominalAccruedAval = p.accruedAval;
    const accruedAval = (nominalAccruedAval * tierRatePct) / 100;
    return {
      dailyRateAval,
      accruedAval,
      maxUnclaimedDays: MAX_UNCLAIMED_DAYS,
      daysUntilCap: Math.max(0, MAX_UNCLAIMED_DAYS - nominalAccruedAval / NOMINAL_DRIP_AVAL_PER_DAY),
      presentDays,
      tenureBonus: tenureFromDays(presentDays),
      tenureMaxBonus: TENURE_MAX_BONUS,
      tierRatePct,
      curve: tenureCurve(720, 72),
    };
  }

  // ─── ME — the identity `loadAvalData(viewingAddress)` was called for: the signed-in viewer's
  // own address when one was passed, else the `ME_ADDRESS` demo fallback (`ctx.viewerIsSelf`
  // records which). ────────────────────────────────────────────────────────────────────────────

  const meBd = breakdownFor(ctx.meId);
  const meBreakdown: VouchContribution[] = meBd.vouchers.map((row) => contributionRowFromEngine(row, ctx.edgeTiming(row.voucher, ctx.meId)));
  const meTier = tierOf(ctx.meId);
  const meDepth = depthOf(ctx.meId);
  const meSlots = ctx.slotsFor(ctx.meId, meTier);
  const meCredential = ctx.credentialFor(ctx.meId);

  const meIsAnchor = isAnchorId(ctx.meId);
  const ME: ScoreResult = {
    address: ctx.addressFor(ctx.meId),
    ensName: ctx.ensNameFor(ctx.meId),
    // Was hardcoded "member". On World Chain mainnet the Address Book is World ID's real one, so
    // the signed-in user genuinely can be an anchor — and calling one a member downstream is what
    // let Home print base 20.0 for an account whose score is fixed at 100.
    kind: meIsAnchor ? "anchor" : "member",
    ...(meIsAnchor ? { anchorSource: ctx.anchorSourceFor(ctx.meId) } : {}),
    // Derived from the engine, never a literal: Home prints `base + counted = score` directly
    // under the dial, so a stale literal here renders arithmetic that contradicts the score
    // shown above it (docs/96-ux-audit.md U-3).
    base: baseScoreFor(ctx.meId),
    tenure: centiToScore(meBd.tenure),
    positiveScore: humanSPlus(ctx.meId),
    score: humanScore(ctx.meId),
    scoreAtRisk: humanScoreAtRisk(ctx.meId),
    tier: meTier,
    depth: meDepth,
    gates: gatesFor(ctx.meId),
    breakdown: meBreakdown,
    slots: meSlots,
    weakestLink: weakestLinkForId(ctx.meId, meTier, meBd, meBreakdown),
    presence: presenceStateForId(ctx.meId, meTier),
    credentialStatus: meCredential.status,
    credentialExpiresAt: meCredential.expiresAt,
  };

  // ─── explore — reachable-from-an-anchor vs. cut off from every anchor ─────────────────────────
  // docs/07-app-api.md §2.4: "both live, both at their real scores."
  //
  // Live mode used to pick both exhibits by MATCHING FIXTURE NAMES against real handles
  // (`/^(anchor\d+|alice|bob|carol)\.aval\.eth$/`, and `startsWith("ring")`). On World Chain
  // mainnet nobody is called any of those, so both columns came back with zero nodes and zero
  // edges — and the page still printed "Six-account collusion ring / Six phones on a table" over
  // a score of 20.0 that was a literal fallback, plus "Every edge points down from a genesis
  // (testnet) anchor" on a deployment whose anchors are genuinely Orb-verified.
  //
  // Both sets are now derived from the graph's own structure, which is what the exhibits were
  // always about: reachable from an anchor (finite depth) vs. no path to any anchor at all.
  const humanIds = ctx.accounts.filter((a) => a.kind === "human").map((a) => a.id);
  const honestIds =
    ctx.mode === "fixture"
      ? ["anchor1.aval.eth", "anchor2.aval.eth", "alice.aval.eth", "bob.aval.eth", ctx.meId, "dave.carol.aval.eth"]
      : humanIds.filter((id) => depthOf(id) !== null);
  const ringIds = ctx.mode === "fixture" ? RING_IDS : humanIds.filter((id) => depthOf(id) === null);

  function edgeContribution(voucher: string, vouchee: string): { contribution: number; counted: boolean; reason: string | null } {
    const row = breakdownFor(vouchee).vouchers.find((v) => v.voucher === voucher);
    if (!row) return { contribution: 0, counted: false, reason: "edge not found" };
    return { contribution: centiToScore(row.contribution), counted: row.counted, reason: voucherReasonText(row) };
  }

  const honestVouches = ctx.vouches.filter((e) => honestIds.includes(e.voucher) && honestIds.includes(e.vouchee));
  const ringVouches = ctx.vouches.filter((e) => ringIds.includes(e.voucher) && ringIds.includes(e.vouchee));

  // Honesty about provenance extends to prose, not just badges (task requirement #5) — this
  // description must not call a genesis-testnet anchor "Orb", NOR call a real Orb anchor
  // "genesis (testnet)", which is what the old hardcoded `ctx.mode` branch did on mainnet.
  // Read from the graph's own anchor source (`chain.ts` decides it by which Address Book is
  // configured, never by guessing).
  const anchorWord =
    ctx.graphAnchorSource === "world-id-orb"
      ? "an Orb-verified anchor"
      : ctx.graphAnchorSource === "genesis-testnet"
        ? "a genesis (testnet) anchor"
        : "an Orb anchor";

  // The deepest reachable account is the one the "honest path" exhibit is actually about: the far
  // end of the chain. Was `ctx.meId` — i.e. whoever happened to be signed in (or, signed out, the
  // ME_ADDRESS fallback), whose score has nothing to do with the exhibit.
  const deepestHonestId = honestIds.reduce<string | null>(
    (best, id) => (best === null || (depthOf(id) ?? -1) > (depthOf(best) ?? -1) ? id : best),
    null,
  );

  const EXPLORE_HONEST: ExploreScenario = {
    label: "Reachable from an anchor",
    exhibit: "EXHIBIT A",
    available: honestIds.length > 0,
    unavailableReason:
      honestIds.length > 0 ? null : "No enrolled account on this deployment has a path to an anchor yet.",
    description:
      honestVouches.length > 0
        ? `Every edge points down from ${anchorWord}. Depth ordering lets each vouch count exactly once.`
        : `${honestIds.length} account${honestIds.length === 1 ? "" : "s"} reachable from ${anchorWord}, and no vouches ` +
          `between them yet — so there is no path to trace.`,
    nodes: honestIds.map((id) => ({
      ensName: ctx.ensNameFor(id),
      address: ctx.addressFor(id),
      kind: "member" as AccountKind,
      score: humanScore(id),
      tier: tierOf(id),
      depth: depthOf(id),
      isAnchor: ctx.accounts.find((a) => a.id === id)?.isAnchor ?? false,
      anchorSource: ctx.anchorSourceFor(id),
    })),
    edges: honestVouches.map((e) => {
      const info = edgeContribution(e.voucher, e.vouchee);
      return {
        from: ctx.ensNameFor(e.voucher),
        to: ctx.ensNameFor(e.vouchee),
        contribution: info.contribution,
        counted: info.counted,
        reason: info.counted ? null : (info.reason ?? "same depth or higher — doesn't count"),
      };
    }),
    finalScore: deepestHonestId ? humanScore(deepestHonestId) : 0,
    finalTier: deepestHonestId ? tierOf(deepestHonestId) : 0,
    gates: deepestHonestId
      ? gatesFor(deepestHonestId)
      : { g1ScoreThreshold: false, g2TwoDistinctVouchers: false, g3PathToOrigin: false, g4NoRecentUpheldReport: true },
  };

  const ringRepresentative = ringIds[0];
  const EXPLORE_RING: ExploreScenario = {
    // Was flatly "Six-account collusion ring / Six phones on a table" whether or not any such
    // cluster existed — on this deployment it does not, and the column still claimed one at a
    // score of 20.0. Label and count now come from the graph.
    label:
      ctx.mode === "fixture"
        ? "Six-account collusion ring"
        : `${ringIds.length} account${ringIds.length === 1 ? "" : "s"} with no path to an anchor`,
    exhibit: "EXHIBIT B",
    available: ringIds.length > 0,
    unavailableReason:
      ringIds.length > 0
        ? null
        : "Every enrolled account on this deployment reaches an anchor, so there is no cut-off cluster to show.",
    description:
      ctx.mode === "fixture"
        ? "Six phones on a table. A valid solution to the scoring equation — and the least fixed point ignores it."
        : "They can vouch for each other all they like: nobody here is closer to an anchor than anybody else, so " +
          "depth ordering gives every edge between them +0.0 and the score stays at the floor.",
    nodes: ringIds.map((id) => ({
      ensName: ctx.ensNameFor(id),
      address: ctx.addressFor(id),
      kind: "member" as AccountKind,
      score: humanScore(id),
      tier: tierOf(id),
      depth: depthOf(id),
      isAnchor: false,
    })),
    edges: ringVouches.map((e) => {
      const info = edgeContribution(e.voucher, e.vouchee);
      return {
        from: ctx.ensNameFor(e.voucher),
        to: ctx.ensNameFor(e.vouchee),
        contribution: info.contribution,
        counted: info.counted,
        reason: info.counted ? null : (info.reason ?? "no path to any anchor"),
      };
    }),
    finalScore: ringRepresentative ? humanScore(ringRepresentative) : 0,
    finalTier: ringRepresentative ? tierOf(ringRepresentative) : 0,
    gates: ringRepresentative ? gatesFor(ringRepresentative) : { g1ScoreThreshold: false, g2TwoDistinctVouchers: false, g3PathToOrigin: false, g4NoRecentUpheldReport: true },
  };

  // ─── reports ─────────────────────────────────────────────────────────────────────────────────

  function reportStatus(r: Report, decayedWeight: number): ReportStatus {
    if (r.state === "rejected" || r.state === "withdrawn") return "rejected";
    if (r.state === "pending") return "pending";
    return decayedWeight === 0 ? "decayed" : "upheld";
  }

  function reporterScoreCenti(reporterId: string): number {
    const acct = ctx.accounts.find((a) => a.id === reporterId);
    if (acct?.kind === "platform") return result.sPlatform[reporterId] ?? 0;
    return result.score[reporterId] ?? BASE;
  }

  const REPORTS: ReportEntry[] = ctx.reports.map((r): ReportEntry => {
    const rw = result.reportWeights[r.id];
    const meta = ctx.reportDisplayMeta(r.id);
    const reporterAcct = ctx.accounts.find((a) => a.id === r.reporter);
    const reporterKind: AccountKind = reporterAcct?.kind === "platform" ? "platform" : reporterAcct?.isAnchor ? "anchor" : "member";
    const baseWeight = rw?.baseWeight ?? 0;
    const decayedW = rw?.decayedWeight ?? 0;
    // One expression for both modes: `filedAt` is a real unix timestamp in live mode (the chain's
    // own `reports(id).filedAt`) and a derived one in fixture mode. It used to be `ctx.now` in
    // live mode, i.e. "filed this second" for every report ever filed.
    const filedAtIso = new Date(meta.filedAt * 1000).toISOString();

    return {
      id: r.id,
      direction: r.target === ctx.meId ? "against" : "filed",
      reporter: { ensName: ctx.ensNameFor(r.reporter), kind: reporterKind, score: centiToScore(reporterScoreCenti(r.reporter)) },
      target: ctx.ensNameFor(r.target),
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
      onChainState: meta.onChainState,
      txHash: meta.txHash,
      bondAval: meta.bondAval,
      // Weight the engine credits BEFORE decay, and whether this report is one of the top-3 that
      // actually move the published score. `countedTowardScore: false` on a valid, upheld report is
      // the top-K cut doing its job (docs/01-trust-math.md §7.3) — or the target being an anchor,
      // whose score ignores every inbound edge (errata E-6). Either way the UI must not imply the
      // report is subtracting points it is not.
      baseWeight: centiToScore(baseWeight),
      valid: rw?.valid ?? false,
      voidReason: rw?.voidReason ?? null,
      countedTowardScore: rw?.countedTowardScore ?? false,
      countedTowardRisk: rw?.countedTowardRisk ?? false,
    };
  });

  // ─── platform — docs/13-platforms.md §3 ────────────────────────────────────────────────────────

  const PLATFORM: PlatformScoreResult = ctx.platformId
    ? (() => {
        const platformSpCenti = result.sPlatform[ctx.platformId!] ?? 0;
        const platformVouchesFor = ctx.platformVouches.filter((pv) => pv.platform === ctx.platformId);
        return {
          registered: true,
          address: ctx.addressFor(ctx.platformId!),
          ensName: ctx.ensNameFor(ctx.platformId!),
          score: centiToScore(platformSpCenti),
          tier: platformTierFromEngine(result.platformTier[ctx.platformId!]),
          voucherCount: platformVouchesFor.length,
          // `bondAval` IS read now — `PlatformRegistry` custodies platform bonds itself, and this
          // module reads that record. The other two stay `null` in live mode because they still
          // have no source: request counts live in the gateway (not deployed), and "upheld rate"
          // is not a quantity ReportRegistry exposes for a platform (the reports it holds are
          // reports FILED BY and AGAINST accounts, with no notion of a platform's hit rate).
          // Rendering 0 / 0 / 0% would present measurements that were never taken as if they had
          // been. The fixture's figures stay, because the fixture says it is a demo graph.
          bondAval: ctx.platformBondAval(ctx.platformId!),
          requestsLast30d: ctx.mode === "fixture" ? 812 : null,
          upheldRatePct: ctx.mode === "fixture" ? 82 : null,
          gates: {
            g1ScoreThreshold: platformSpCenti >= P1,
            g2TwoDistinctVouchers: new Set(platformVouchesFor.map((pv) => pv.voucher)).size >= MIN_VOUCHERS,
            // `MIN_REGISTRATION_BOND` is 5 000 AVAL (PlatformRegistry.sol:60), and registration is
            // impossible below it — but read the bond rather than infer it from "it registered".
            g3BondPosted: (() => {
              const b = ctx.platformBondAval(ctx.platformId!);
              return b === null ? null : b >= 5_000;
            })(),
          },
        };
      })()
    : {
        // No platform on this graph. `registered: false` covers both "PlatformRegistry was read
        // and nobody has registered" and "this deployment does not read PlatformRegistry at all" —
        // `AvalData.platformsAvailable` is the field that distinguishes them, and /platform must
        // use it rather than printing a console full of zeros either way.
        registered: false,
        address: "0x0000000000000000000000000000000000000000",
        ensName: "no platform registered",
        score: 0,
        tier: "P0",
        voucherCount: 0,
        bondAval: null,
        requestsLast30d: null,
        upheldRatePct: null,
        gates: { g1ScoreThreshold: false, g2TwoDistinctVouchers: false, g3BondPosted: null },
      };

  // ─── agent — docs/04-ens.md §4, docs/07-app-api.md §2.5 ────────────────────────────────────────

  const meHandle = ctx.ensNameFor(ctx.meId);
  // Nothing in this record exists. Agent subname registration has not shipped: `/api/ens/mint`
  // only ever mints the operator's own `<handle>.aval.eth`, there is no ENSIP-26/25 registrar
  // call anywhere in this repo, and none of the hostnames below serve anything. `exampleLabel`
  // is exactly that — an example, not a name anyone chose or reserved — and `/agents` is required
  // to say so on screen next to every value it prints (docs/96-ux-audit.md U-9).
  const AGENT_EXAMPLE_LABEL = "agent";
  const agentSubname = `${AGENT_EXAMPLE_LABEL}.${meHandle}`;
  const AGENT: AgentRecord = {
    published: false,
    exampleLabel: AGENT_EXAMPLE_LABEL,
    subname: agentSubname,
    operator: meHandle,
    operatorScore: humanScore(ctx.meId),
    inheritedTier: meTier,
    endpointMcp: `https://mcp.aval.xyz/agent/${agentSubname}`,
    endpointA2a: `https://a2a.aval.xyz/${agentSubname}`,
    ensip26: {
      "agent-context": `# ${agentSubname}\n\nOperated by ${meHandle} (Aval tier ${meTier}, score ${humanScore(
        ctx.meId,
      ).toFixed(1)}).\n\n**Delegated authority:** this agent inherits tier ${meTier}. It CANNOT issue vouches — vouching requires a human, and ENSIP-26 agents are not one.`,
      "agent-endpoint[mcp]": `https://mcp.aval.xyz/agent/${agentSubname}`,
      "agent-endpoint[a2a]": `https://a2a.aval.xyz/${agentSubname}`,
      "agent-endpoint[web]": `https://aval.xyz/a/${agentSubname}`,
    },
    // Chain id from the configured chain, not a literal 480 that silently becomes wrong the day
    // this points anywhere else.
    ensip25RegistrationKey: `agent-registration[eip155:${WORLDCHAIN_ID}:${ctx.addressFor(ctx.meId)}][0x01]`,
  };

  // ─── candidates — prospective vouchers for any id ──────────────────────────────────────────────

  function candidatesForId(idOrAddress: string): CandidateVoucher[] {
    return ctx.candidatesFor(idOrAddress).map((id) => ({
      ensName: ctx.ensNameFor(id),
      address: ctx.addressFor(id),
      score: humanScore(id),
      tier: tierOf(id),
      mutualConnections: 0, // no engine equivalent — "shared connections" isn't a scoring concept
      slotsFree: ctx.slotsFor(id, tierOf(id)).free,
    }));
  }

  const CANDIDATES: CandidateVoucher[] = candidatesForId(ctx.meId);

  // ─── vouch simulation preview — docs/07-app-api.md §2.3 step 2 ─────────────────────────────────
  // Genuinely simulates the hypothetical edge by adding it to the graph and calling `compute()`
  // again, for whichever candidate is best-ranked — not a standalone "voucher.score x 0.25"
  // approximation, which (unlike the real engine) wouldn't even check depth ordering.

  function secondaryEffectsBetween(before: EngineOutput, after: EngineOutput, exclude: string): SimulateVouchStep[] {
    return ctx.accounts
      .filter((a) => a.kind === "human" && a.id !== exclude)
      .map((a) => ({
        ensName: ctx.ensNameFor(a.id),
        before: centiToScore(before.score[a.id] ?? BASE),
        after: centiToScore(after.score[a.id] ?? BASE),
      }))
      .filter((s) => s.before !== s.after);
  }

  function simulateVouchGeneric(rawVoucherId: string, rawTargetId: string): SimulateVouchResult {
    // Case-insensitive id resolution. Live account ids ARE addresses, and address casing is a
    // rendering detail of the same 20 bytes — but a strict `===` here silently missed, dropping
    // into the "unknown account" branch and reporting `0 slots -> 0` with no blockers for two
    // accounts that plainly exist. That branch looks like a real answer, which is what made it
    // dangerous: the vouch preview showed nothing wrong for a vouch that would revert.
    const findHuman = (id: string) =>
      ctx.accounts.find((a) => a.kind === "human" && (a.id === id || a.id.toLowerCase() === id.toLowerCase()));
    const voucherAcc = findHuman(rawVoucherId);
    const targetAcc = findHuman(rawTargetId);
    const voucherId = voucherAcc?.id ?? rawVoucherId;
    const targetId = targetAcc?.id ?? rawTargetId;
    if (!voucherAcc || !targetAcc) {
      return {
        voucher: ctx.ensNameFor(voucherId),
        target: ctx.ensNameFor(targetId),
        // Was a literal 10 — stale since errata E-16 raised `base` to 20, and rendered in the
        // vouch wizard's preview step whenever either side wasn't a known human account.
        targetBefore: { score: humanScore(targetId), tier: tierOf(targetId) },
        targetAfter: { score: humanScore(targetId), tier: tierOf(targetId) },
        promotes: false,
        voucherSlotsBefore: 0,
        voucherSlotsAfter: 0,
        nextVouchAvailableInHours: 0,
        secondaryEffects: [],
        blockers: [],
      };
    }
    const alreadyVouches = ctx.vouches.some((v) => v.voucher === voucherId && v.vouchee === targetId && v.active);
    const afterResult = alreadyVouches ? result : compute({ ...engineInput, vouches: [...ctx.vouches, mkVouch(voucherId, targetId)] });

    // Both revert conditions in `AvalRegistry.vouch()`, read from live `members()` state rather
    // than assumed. Checking these BEFORE the wizard starts is the difference between refusing a
    // vouch and walking someone through a face scan into a transaction that cannot land.
    const lastVouchAt = ctx.lastVouchAtFor(voucherId);
    const nowSeconds = Math.floor(ctx.now.getTime() / 1000);
    const secondsSinceVouch = lastVouchAt > 0 ? nowSeconds - lastVouchAt : Number.POSITIVE_INFINITY;
    const rateLimited = secondsSinceVouch < 86_400;
    const hoursUntilNextVouch = rateLimited ? Math.max(0, Math.ceil((86_400 - secondsSinceVouch) / 3600)) : 0;
    const blockers: string[] = [];
    if (alreadyVouches) blockers.push("You already vouch for this account — a second vouch would revert.");
    if (rateLimited) {
      blockers.push(
        `You vouched for someone in the last 24 hours. You can vouch again in ${hoursUntilNextVouch}h.`,
      );
    }

    const beforeScore = humanScore(targetId);
    const beforeTier = tierOf(targetId);
    const afterScore = centiToScore(afterResult.score[targetId] ?? BASE);
    const afterTier = (afterResult.tier[targetId] ?? 0) as Tier;
    const voucherSlots = ctx.slotsFor(voucherId, tierOf(voucherId));

    return {
      voucher: ctx.ensNameFor(voucherId),
      target: ctx.ensNameFor(targetId),
      targetBefore: { score: beforeScore, tier: beforeTier },
      targetAfter: { score: afterScore, tier: afterTier },
      promotes: afterTier > beforeTier,
      voucherSlotsBefore: voucherSlots.free,
      voucherSlotsAfter: Math.max(0, voucherSlots.free - 1),
      nextVouchAvailableInHours: hoursUntilNextVouch,
      secondaryEffects: alreadyVouches ? [] : secondaryEffectsBetween(result, afterResult, targetId),
      blockers,
    };
  }

  const defaultVoucherId = ctx.candidatesFor(ctx.meId)[0];
  const VOUCH_SIMULATION: SimulateVouchResult =
    ctx.mode === "fixture"
      ? (() => {
          // Reproduces the exact moment bob's vouch lands on carol: 22.5 -> 35.0, Tier 0 -> Tier 1
          const withoutBob = ctx.vouches.filter((v) => !(v.voucher === "bob.aval.eth" && v.vouchee === ctx.meId));
          const resultWithoutBob = compute({ ...engineInput, vouches: withoutBob });
          const meScoreIfBobExpires = centiToScore(resultWithoutBob.score[ctx.meId] ?? BASE);
          const meTierIfBobExpires = (resultWithoutBob.tier[ctx.meId] ?? 0) as Tier;
          return {
            voucher: "bob.aval.eth",
            target: ctx.meId,
            targetBefore: { score: meScoreIfBobExpires, tier: meTierIfBobExpires },
            targetAfter: { score: humanScore(ctx.meId), tier: meTier },
            promotes: meTierIfBobExpires < meTier,
            voucherSlotsBefore: 3,
            voucherSlotsAfter: 2,
            nextVouchAvailableInHours: 24,
            secondaryEffects: secondaryEffectsBetween(resultWithoutBob, result, ctx.meId),
            blockers: [],
          };
        })()
      : defaultVoucherId
        ? simulateVouchGeneric(defaultVoucherId, ctx.meId)
        : {
            voucher: "",
            target: ctx.ensNameFor(ctx.meId),
            targetBefore: { score: humanScore(ctx.meId), tier: meTier },
            targetAfter: { score: humanScore(ctx.meId), tier: meTier },
            promotes: false,
            voucherSlotsBefore: 0,
            voucherSlotsAfter: 0,
            nextVouchAvailableInHours: 24,
            secondaryEffects: [],
            blockers: [],
          };

  function simulateVouch(voucherId: string, targetId: string): SimulateVouchResult {
    if (ctx.mode === "fixture" && voucherId === "bob.aval.eth" && targetId === ctx.meId) return VOUCH_SIMULATION;
    return simulateVouchGeneric(voucherId, targetId);
  }

  // ─── generic score lookup — powers /api/score/[address] and /api/explain/[address] ─────────────

  function getScoreResult(idOrAddress: string): ScoreResult | undefined {
    if (idOrAddress === ctx.meId || idOrAddress === ME.address || idOrAddress === ME.ensName) return ME;
    const acc = ctx.accounts.find(
      (a) => a.kind === "human" && (a.id === idOrAddress || ctx.addressFor(a.id) === idOrAddress || ctx.ensNameFor(a.id) === idOrAddress),
    );
    if (!acc) return undefined;
    const id = acc.id;
    const t = tierOf(id);
    const cred = ctx.credentialFor(id);
    const bd = breakdownFor(id);
    // Errata E-6: "Inbound vouches to an anchor are recorded, are VISIBLE IN THE UI, and
    // contribute nothing." This used to hand back `[]` for anchors, so a profile with real inbound
    // vouches rendered "No vouches yet." The engine already marks each row `counted: false` with
    // the reason `anchor_ignores_inbound`, which is what the zero-contribution row is for.
    const displayBreakdown = genericBreakdown(id);
    return {
      address: ctx.addressFor(id),
      ensName: ctx.ensNameFor(id),
      kind: acc.isAnchor ? "anchor" : "member",
      ...(acc.isAnchor ? { anchorSource: ctx.anchorSourceFor(id) } : {}),
      base: baseScoreFor(id),
      tenure: centiToScore(bd.tenure),
      positiveScore: humanSPlus(id),
      score: humanScore(id),
      scoreAtRisk: humanScoreAtRisk(id),
      tier: t,
      depth: depthOf(id),
      gates: gatesFor(id),
      breakdown: displayBreakdown,
      slots: ctx.slotsFor(id, t),
      // Anchors ignore inbound edges entirely (score fixed at 100) — a weakest-link warning about
      // an edge that can't move their score would be noise, not signal.
      weakestLink: acc.isAnchor ? null : weakestLinkForId(id, t, bd, displayBreakdown),
      presence: presenceStateForId(id, t),
      credentialStatus: cred.status,
      credentialExpiresAt: cred.expiresAt,
    };
  }

  /** Powers `/api/candidates/[address]` for any enrolled address, not only `ME` (task correction:
   *  the vouch wizard needs the signed-in viewer's own candidate list). */
  function getCandidates(idOrAddress: string): CandidateVoucher[] | undefined {
    if (idOrAddress === ctx.meId || idOrAddress === ME.address || idOrAddress === ME.ensName) return CANDIDATES;
    const acc = ctx.accounts.find(
      (a) => a.kind === "human" && (a.id === idOrAddress || ctx.addressFor(a.id) === idOrAddress || ctx.ensNameFor(a.id) === idOrAddress),
    );
    if (!acc) return undefined;
    return candidatesForId(acc.id);
  }

  /** Whether `idOrAddress` has an `Enrolled` record at all — distinct from "score/tier exist",
   *  since every generic lookup above already defaults gracefully to base score for an address
   *  that was never enrolled. The enroll wizard needs the sharper "is this address already a
   *  member" fact on its own. */
  function isEnrolled(idOrAddress: string): boolean {
    const acc = ctx.accounts.find(
      (a) => a.id === idOrAddress || ctx.addressFor(a.id) === idOrAddress || ctx.ensNameFor(a.id) === idOrAddress,
    );
    return acc ? ctx.isEnrolledId(acc.id) : false;
  }

  function explainProse(idOrAddress: string): string | undefined {
    const r = getScoreResult(idOrAddress);
    if (!r) return undefined;
    if (r.kind === "anchor") {
      const provenance = r.anchorSource === "world-id-orb" ? "an Orb-verified" : `a ${r.anchorSource ?? "an unlabelled"}`;
      return `${r.ensName} is ${provenance} anchor. Its score is fixed at 100.00 and ignores every inbound edge, positive or negative (docs/01-trust-math.md §2) — it is depth 0 by definition, the externally-grounded floor the rest of the graph is measured from.`;
    }
    const counted = r.breakdown.filter((b) => b.counted);
    const zero = r.breakdown.filter((b) => !b.counted);
    const countedSum = counted.reduce((sum, b) => sum + b.contribution, 0);
    const parts: string[] = [];
    parts.push(
      `${r.ensName} is Tier ${r.tier} with a score of ${r.score.toFixed(1)}, at depth ${r.depth ?? "∞"} from the nearest anchor.`,
    );
    // Live, for the one enrolled account on this deployment, the old form produced the sentence
    // "That score is base 20.0 plus ." — a dangling clause under a score of 100. Every branch now
    // has to name terms that actually sum to the score, or say plainly that there are none.
    if (counted.length > 0) {
      parts.push(
        `That score is base ${r.base.toFixed(1)} plus ${counted
          .map((b) => `${b.voucher.ensName} contributing +${b.contribution.toFixed(1)} (${b.voucher.score.toFixed(1)} x ${DISPLAY_M_POS})`)
          .join(", ")} = ${(r.base + countedSum).toFixed(1)}.`,
      );
    } else {
      parts.push(`No vouch counts toward it yet, so the score is its base of ${r.base.toFixed(1)}.`);
    }
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

  // ─── identity directory + gate + path ──────────────────────────────────────────────────────────

  function findIdentity(idOrAddress: string): IdentityResult | undefined {
    const entry = ctx.directory.find(
      (d) => d.id === idOrAddress || ctx.addressFor(d.id) === idOrAddress || ctx.ensNameFor(d.id) === idOrAddress,
    );
    if (!entry) return undefined;
    const cred = ctx.credentialFor(entry.id);
    return {
      address: ctx.addressFor(entry.id),
      ensName: ctx.ensNameFor(entry.id),
      kind: entry.kind,
      registeredAt: ctx.mode === "fixture" ? fixtureIso(-entry.registeredAgoDays) : new Date(ctx.now.getTime() - entry.registeredAgoDays * DAY_MS).toISOString(),
      credential: entry.credential,
      credentialStatus: cred.status,
      ...(entry.kind === "anchor" ? { anchorSource: ctx.anchorSourceFor(entry.id) } : {}),
    };
  }

  function checkGate(idOrAddress: string, policy: GatePolicy): GateResult {
    const identity = findIdentity(idOrAddress);
    if (!identity) return { allow: false, reasons: ["identity_not_found"] };
    const reasons: string[] = [];
    const isPlatform = identity.kind === "platform";
    const idKey = ctx.accounts.find((a) => ctx.ensNameFor(a.id) === identity.ensName)?.id ?? identity.ensName;
    const t = isPlatform ? (result.platformTier[idKey] ?? 0) : tierOf(idKey);
    const s = isPlatform ? centiToScore(result.sPlatform[idKey] ?? 0) : humanScore(idKey);
    if (policy.minTier !== undefined && t < policy.minTier) reasons.push(`tier ${t} below required tier ${policy.minTier}`);
    if (policy.minScore !== undefined && s < policy.minScore) reasons.push(`score ${s.toFixed(1)} below required score ${policy.minScore.toFixed(1)}`);
    if (policy.requireCredential && identity.credential !== policy.requireCredential) {
      reasons.push(`credential ${identity.credential} does not satisfy required credential ${policy.requireCredential}`);
    }
    return { allow: reasons.length === 0, reasons };
  }

  function parentOf(id: string): string | undefined {
    const d = result.depth[id];
    if (d === undefined) return undefined;
    const edge = ctx.vouches.find((e) => e.vouchee === id && result.depth[e.voucher] === d - 1);
    return edge?.voucher;
  }

  /** Walks from `fromEnsName` back to the literal string "anchor", or to a specific target name. */
  function findPath(fromEnsName: string, toEnsName: string): PathResult {
    // R-12 (docs/97-review-engine-app.md): an entirely unknown starting identity must yield zero
    // hops, so the route's existing `hops.length === 0` check 404s — not a single synthetic hop.
    const fromId = ctx.accounts.find((a) => a.id === fromEnsName || ctx.ensNameFor(a.id) === fromEnsName)?.id;
    if (!fromId) return { from: fromEnsName, to: toEnsName, found: false, hops: [] };
    const toId = ctx.accounts.find((a) => a.id === toEnsName || ctx.ensNameFor(a.id) === toEnsName)?.id;

    const hops: PathResult["hops"] = [];
    let cursor: string | undefined = fromId;
    let previous: string | undefined;
    const visited = new Set<string>();
    while (cursor && !visited.has(cursor)) {
      visited.add(cursor);
      const contributionCenti =
        previous === undefined ? 0 : (breakdownFor(previous).vouchers.find((v) => v.voucher === cursor)?.contribution ?? 0);
      hops.push({
        ensName: ctx.ensNameFor(cursor),
        address: ctx.addressFor(cursor),
        depth: depthOf(cursor) ?? -1,
        contribution: centiToScore(contributionCenti),
      });
      if ((toEnsName === "anchor" && (result.depth[cursor] ?? Number.POSITIVE_INFINITY) === 0) || cursor === toId || ctx.ensNameFor(cursor) === toEnsName) {
        return { from: fromEnsName, to: toEnsName, found: true, hops };
      }
      previous = cursor;
      cursor = parentOf(cursor);
    }
    return { from: fromEnsName, to: toEnsName, found: false, hops };
  }

  // ─── health ─────────────────────────────────────────────────────────────────────────────────

  const HEALTH: HealthResult =
    ctx.mode === "fixture"
      ? {
          status: "ok",
          subgraphDeployment: ctx.meta.subgraphDeployment,
          indexedBlock: ctx.meta.computedAtBlock,
          chainHead: ctx.meta.computedAtBlock + ctx.meta.indexerLagBlocks,
          lagBlocks: ctx.meta.indexerLagBlocks,
        }
      : // filled in by loadAvalData(), which has the async chain-health call this sync function
        // can't make — see the live branch below.
        {
          status: "ok",
          subgraphDeployment: ctx.meta.subgraphDeployment,
          indexedBlock: ctx.meta.computedAtBlock,
          chainHead: ctx.meta.computedAtBlock,
          lagBlocks: 0,
        };

  return {
    mode: ctx.mode,
    meta: ctx.meta,
    reportsAvailable: ctx.reportsAvailable,
    platformsAvailable: ctx.platformsAvailable,
    viewerIsSelf: ctx.viewerIsSelf,
    ME,
    PLATFORM,
    REPORTS,
    AGENT,
    EXPLORE_HONEST,
    EXPLORE_RING,
    HEALTH,
    CANDIDATES,
    VOUCH_SIMULATION,
    NOW: ctx.now,
    getScoreResult,
    getCandidates,
    isEnrolled,
    explainProse,
    findIdentity,
    checkGate,
    findPath,
    simulateVouch,
  };
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// ─── entry point — memoized per mode; LIVE additionally caches by block via chain.ts ─────────────

let fixtureCache: AvalData | null = null;

/**
 * `viewingAddress`, when provided, is the signed-in wallet whose own data `ME` should reflect
 * (from the `aval_addr` cookie `session.tsx` sets — see `page.tsx`). Omitted, it falls back to
 * the read-only `ME_ADDRESS` demo identity, and `viewerIsSelf` comes back `false` so the UI can
 * label the fallback plainly rather than silently pretending it's the visitor's own account.
 *
 * No block-keyed second-layer cache here anymore: the result is per-viewer now (two different
 * signed-in addresses must never share a cached `ME`), and the actually expensive part — the
 * Multicall3-batched chain read — is already cached inside `getLiveGraph()` (15s TTL). What's left
 * (`compute()` over an already-fetched graph) is cheap enough to just always run.
 */
export async function loadAvalData(viewingAddress?: Address): Promise<AvalData> {
  if (getChainMode() === "fixture") {
    if (!fixtureCache) fixtureCache = deriveAvalData(buildFixtureContext());
    return fixtureCache;
  }

  const ctx = await buildLiveContext(viewingAddress);
  const blockNum = ctx.meta.computedAtBlock;
  const data = deriveAvalData(ctx);
  const chainHealth = await getChainHealth();
  data.HEALTH = {
    status: "ok",
    subgraphDeployment: ctx.meta.subgraphDeployment,
    indexedBlock: blockNum,
    chainHead: Number(chainHealth.currentBlock),
    lagBlocks: Math.max(0, Number(chainHealth.currentBlock) - blockNum),
    deploymentBlock: Number(chainHealth.deploymentBlock),
    chainId: chainHealth.chainId,
  };

  return data;
}
