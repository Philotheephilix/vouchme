/**
 * VouchMe — the scoring engine (docs/01-trust-math.md §3–§9, §15; docs/16-presence-drip.md §7).
 *
 * `compute()` is a pure function: no I/O, no `Date.now()`, no randomness, no floats in the
 * scoring path. `now` is supplied by the caller. All scores are integer centi-points
 * (score × 100); every division below truncates toward zero, once, before the result is summed
 * or stored — nothing compounds (01-trust-math.md §10, §15, invariant I-15).
 *
 * The five stages, in order (01-trust-math.md §3):
 *
 *   0  anchors                    fixed at ANCHOR, ignore every inbound edge
 *   1  s⁺  positive human scores  BFS least fixed point; outer origins loop; reports IGNORED
 *   2  s_P platform scores        from s⁺ only
 *   3  d   report weights         from s⁺ / s_P only; voiding is a boolean, not a weight
 *   4  s, s_risk final scores     max(floor, s⁺ − Σ top-K upheld weight)
 *   5  tier(s), tier_P(s_P)       promotion gates
 *
 * Stratified evaluation is what keeps this a single deterministic pass: negative weights are
 * computed from positive-only scores in a strictly later stage, so there is no feedback edge and
 * therefore no cycle.
 *
 * Where this engine resolves an ambiguity in the reference spec:
 *
 * 1. **A Tier-2 origin's own s⁺ across outer rounds** is *persisted* once established (anchors
 *    are always `ANCHOR`; a promoted Tier-2 member keeps the s⁺ that proved it crossed `T2`).
 *    The reference pseudocode (01-trust-math.md §15) resets every account to `BASE` at the start
 *    of each outer round and only recomputes depth 1..MAX_DEPTH, which would park newly-depth-0
 *    origins at `BASE` and break the stated monotonicity invariant I-4 (`O_k ⊆ O_{k+1}`).
 *    Persisting is order-independent and changes no published value: a qualifying Tier-2 score is
 *    always ≥ `T2` (14 000 centi), above the threshold where the positive cap starts binding
 *    (`CAP_POS_BINDING_THRESHOLD`, 8 000 centi), so the contribution to a vouchee is the capped
 *    2 000 either way.
 * 2. **Report `state` filtering.** Only `pending` and `upheld` reports are ever valid;
 *    `rejected`/`withdrawn` are void with reason `report_rejected` / `report_withdrawn` and
 *    contribute to neither published number. This matches docs/12-reporting.md's contract `State`
 *    enum, where those states mean the accusation did not stand.
 * 3. **The "under an upheld report" (voided-reporter) window** is 180 days
 *    (`REPORT_DECAY_DAYS`) — the same clock that zeroes the report's own weight
 *    (docs/01-trust-math.md §7.4), so a voided reporter is rehabilitated exactly when the report
 *    against them stops mattering. This is distinct from gate 4's 90-day window, which is a
 *    narrower, Tier-2-only origin-eligibility rule (docs/01-trust-math.md §11).
 * 4. **Gate 4 uses raw report state, not stage-3 validity.** The gate runs inside the stage-1
 *    origin loop, before stage 3 (report validity/voiding) is computable in general; keeping it a
 *    fully separate raw check keeps the stratification strict.
 *
 * Gate 2 ("≥ 2 distinct active inbound vouches") counts *contributing* vouchers — distinct active
 * inbound vouches from strictly lower depth — not raw inbound edges (docs/01-trust-math.md §11,
 * §12.1). A same-depth voucher contributes 0 to the score, so counting it would let an account
 * reach Tier 1 on what is really a single point of trust, which is exactly what gate 2 exists to
 * prevent. See `distinctContributingVoucherCount` below.
 */

import {
  ANCHOR,
  BASE,
  CAP_NEG,
  CAP_POS,
  GATE4_WINDOW_DAYS,
  MAX_DEPTH,
  MAX_ROUNDS,
  MIN_VOUCHERS,
  M_NEG_DEN,
  M_NEG_NUM,
  M_POS_DEN,
  M_POS_NUM,
  P1,
  P2,
  REPORT_DECAY_DAYS,
  SECONDS_PER_DAY,
  T1,
  T2,
  TOP_K,
} from "./constants.js";
import { tenureCenti } from "./tenure.js";
import type {
  Account,
  EngineInput,
  EngineOutput,
  PlatformTier,
  PlatformVouch,
  Report,
  ReportWeightResult,
  Tier,
  Vouch,
} from "./types.js";

/**
 * Deduplicate vouch records to one canonical edge per ordered pair (voucher, vouchee). Used by
 * BOTH `compute()` (the s⁺ sum, gate 2, and the depth BFS) and `breakdown()` in explain.ts, so
 * every consumer of raw `Vouch[]` input agrees on the same canonical edge set — an indexer replay
 * or duplicated subgraph event must not let one voucher's edge count twice toward s⁺, nor show up
 * as multiple rows in a score explanation.
 *
 * Tie-break for conflicting duplicate records of the same pair (e.g. one marked active, one not):
 * prefer the active one. `Vouch` carries no timestamp of its own — resolving "latest" already
 * happened in the caller, per this type's own doc comment on `active` — so "prefer active" is the
 * only tie-break the engine has enough information to make deterministically (order-independent,
 * I-5); when duplicates agree, the choice doesn't affect the result either way.
 */
export function dedupeVouches(vouches: readonly Vouch[]): Vouch[] {
  const byPair = new Map<string, Vouch>();
  for (const v of vouches) {
    const pairKey = `${v.voucher}::${v.vouchee}`;
    const existing = byPair.get(pairKey);
    if (!existing || (!existing.active && v.active)) {
      byPair.set(pairKey, v);
    }
  }
  return [...byPair.values()];
}

// ── contribution / report-weight formulas (01-trust-math.md §10) ───────────────────────────────

/** min(s × m⁺, cap⁺), truncated toward zero. `s` is always ≥ 0 in this engine. Exported so
 *  consumers like explain.ts import the real formula instead of duplicating its constants as bare
 *  literals that can silently drift from this one. */
export function weightPos(s: number): number {
  return Math.min(Math.trunc((s * M_POS_NUM) / M_POS_DEN), CAP_POS);
}

/** min(s × m⁻, cap⁻), truncated toward zero. `s` is always ≥ 0 in this engine. Exported for the
 *  same reason as `weightPos` above. */
export function weightNeg(s: number): number {
  return Math.min(Math.trunc((s * M_NEG_NUM) / M_NEG_DEN), CAP_NEG);
}

/** Linear decay to zero over REPORT_DECAY_DAYS after `upheldAt` (01-trust-math.md §7.4). Pending
 *  reports (not yet upheld) carry full weight — decay is anchored to the upheld verdict, not to
 *  filing time. All-integer: works in seconds so nothing needs a fractional "days" value. */
function decayedWeight(baseWeight: number, report: Report, now: number): number {
  if (baseWeight <= 0) return 0;
  if (report.state !== "upheld" || report.upheldAt === undefined) return baseWeight;
  const elapsedSeconds = now - report.upheldAt;
  if (elapsedSeconds <= 0) return baseWeight;
  const totalSeconds = REPORT_DECAY_DAYS * SECONDS_PER_DAY;
  if (elapsedSeconds >= totalSeconds) return 0;
  const remainingSeconds = totalSeconds - elapsedSeconds;
  return Math.trunc((baseWeight * remainingSeconds) / totalSeconds);
}

function byIdThenWeightDesc(
  a: { r: Report; decayedWeight: number },
  b: { r: Report; decayedWeight: number },
): number {
  if (b.decayedWeight !== a.decayedWeight) return b.decayedWeight - a.decayedWeight;
  // Deterministic, input-order-independent tie-break (invariant I-5). Ties never change the
  // *sum* (equal weights), only which report ids are flagged `counted*` in the detail output.
  return a.r.id < b.r.id ? -1 : a.r.id > b.r.id ? 1 : 0;
}

function buildReportResult(
  r: Report,
  ev: { valid: boolean; voidReason?: string; baseWeight: number; decayedWeight: number },
  countedTowardScore: boolean,
  countedTowardRisk: boolean,
): ReportWeightResult {
  const result: ReportWeightResult = {
    reportId: r.id,
    reporter: r.reporter,
    target: r.target,
    valid: ev.valid,
    baseWeight: ev.baseWeight,
    decayedWeight: ev.decayedWeight,
    countedTowardScore,
    countedTowardRisk,
  };
  // exactOptionalPropertyTypes: never assign `voidReason: undefined` explicitly.
  return ev.voidReason !== undefined ? { ...result, voidReason: ev.voidReason } : result;
}

/**
 * compute — the whole engine. See the module doc for the five stages and the resolved
 * ambiguities. `input` is never mutated.
 */
export function compute(input: EngineInput): EngineOutput {
  const { now } = input;

  // A malformed `now` or `report.upheldAt` — NaN, ±Infinity, or a non-integer — must fail loudly,
  // not propagate silently into decay / gate-4-window arithmetic as NaN-tainted output.
  // `tenureCenti` guards its own input the same way (tenure.ts).
  if (!Number.isFinite(now) || !Number.isInteger(now)) {
    throw new RangeError(`compute: input.now must be a finite integer (unix seconds), got ${now}`);
  }
  for (const r of input.reports) {
    if (r.upheldAt !== undefined && (!Number.isFinite(r.upheldAt) || !Number.isInteger(r.upheldAt))) {
      throw new RangeError(
        `compute: report "${r.id}" upheldAt must be a finite integer (unix seconds) when present, got ${r.upheldAt}`,
      );
    }
    // `upheldAt` is required when state is "upheld" (types.ts). An upheld report without one would
    // be privileged twice over:
    //   - §7.4 decay is a function of age, so with no timestamp the report never decays and
    //     inflicts maximum damage forever;
    //   - the 180-day `isVoidedReporter` window is measured from the same field, so its reporter is
    //     never voided and can keep filing.
    // Both failure modes favour the reporter, which is the wrong direction to fail in. An absent
    // timestamp is missing data, not "time zero", so refuse it rather than guess.
    if (r.state === "upheld" && r.upheldAt === undefined) {
      throw new RangeError(
        `compute: report "${r.id}" has state "upheld" but no upheldAt. It drives both §7.4 decay ` +
          `and the 180-day reporter-voiding window, so it cannot be defaulted.`,
      );
    }
    // `snapshotWeight` is typed as required, but the engine is also consumed from plain JS
    // (scripts/) and from data assembled at runtime out of chain logs, where a missing or
    // malformed value arrives as `undefined`/`NaN` and propagates through `min(...)` into every
    // score in the graph. A NaN score is not a wrong number, it is an unnoticed one: it compares
    // false against every threshold, so tiers silently collapse rather than erroring.
    if (!Number.isFinite(r.snapshotWeight) || !Number.isInteger(r.snapshotWeight) || r.snapshotWeight < 0) {
      throw new RangeError(
        `compute: report "${r.id}" snapshotWeight must be a non-negative integer (centi-points), ` +
          `got ${r.snapshotWeight}. It bounds report damage to what the reporter actually paid for ` +
          `(01-trust-math.md §7.1) and cannot be defaulted.`,
      );
    }
  }

  // ── setup: index accounts, filter to active ones, split by kind ────────────────────────────
  const accountsById = new Map<string, Account>();
  for (const a of input.accounts) {
    if (a.active === false) continue;
    accountsById.set(a.id, a);
  }

  const humans = [...accountsById.values()]
    .filter((a) => a.kind === "human")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const platforms = [...accountsById.values()]
    .filter((a) => a.kind === "platform")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const anchorIds = new Set(humans.filter((a) => a.isAnchor === true).map((a) => a.id));

  function tenureOf(acct: Account): number {
    return tenureCenti(acct.epochsClaimed ?? 0);
  }

  // Deduplicate by (voucher, vouchee) BEFORE anything downstream sees the edge list — see
  // `dedupeVouches` above for why and for the tie-break rule.
  const dedupedVouches = dedupeVouches(input.vouches);

  // Active vouches: both endpoints must resolve to active human accounts (defensively enforces
  // invariant I-16 — a platform can never be the source of a positive human edge — by
  // construction, regardless of what a caller hands in).
  const activeVouches = dedupedVouches.filter(
    (v) =>
      v.active &&
      accountsById.get(v.voucher)?.kind === "human" &&
      accountsById.get(v.vouchee)?.kind === "human",
  );
  const activePlatformVouches: PlatformVouch[] = input.platformVouches.filter(
    (pv) =>
      pv.active &&
      accountsById.get(pv.voucher)?.kind === "human" &&
      accountsById.get(pv.platform)?.kind === "platform",
  );

  const inboundVouches = new Map<string, string[]>();
  const outboundVouches = new Map<string, string[]>();
  for (const v of activeVouches) {
    if (!inboundVouches.has(v.vouchee)) inboundVouches.set(v.vouchee, []);
    inboundVouches.get(v.vouchee)!.push(v.voucher);
    if (!outboundVouches.has(v.voucher)) outboundVouches.set(v.voucher, []);
    outboundVouches.get(v.voucher)!.push(v.vouchee);
  }

  const platformInbound = new Map<string, PlatformVouch[]>();
  for (const pv of activePlatformVouches) {
    if (!platformInbound.has(pv.platform)) platformInbound.set(pv.platform, []);
    platformInbound.get(pv.platform)!.push(pv);
  }

  const reportsByTarget = new Map<string, Report[]>();
  for (const r of input.reports) {
    if (!reportsByTarget.has(r.target)) reportsByTarget.set(r.target, []);
    reportsByTarget.get(r.target)!.push(r);
  }

  // Gate 2 counts *contributing* vouchers — distinct active inbound vouches from strictly lower
  // depth — not raw inbound edges: a same-depth voucher contributes 0 to the score, so counting it
  // would let an account reach Tier 1 on what is really a single point of trust. A target with
  // undefined/unreachable depth has zero contributing vouchers by definition
  // (docs/01-trust-math.md §11, §12.1).
  function distinctContributingVoucherCount(id: string, depthMap: Map<string, number>): number {
    const vs = inboundVouches.get(id);
    if (!vs) return 0;
    const targetDepth = depthMap.get(id);
    if (targetDepth === undefined) return 0;
    const contributing = new Set<string>();
    for (const srcId of vs) {
      const srcDepth = depthMap.get(srcId);
      if (srcDepth !== undefined && srcDepth < targetDepth) contributing.add(srcId);
    }
    return contributing.size;
  }

  function hasRecentUpheldReport(id: string, windowDays: number): boolean {
    const rs = reportsByTarget.get(id);
    if (!rs) return false;
    return rs.some(
      (r) =>
        r.state === "upheld" &&
        r.upheldAt !== undefined &&
        now - r.upheldAt < windowDays * SECONDS_PER_DAY &&
        now - r.upheldAt >= 0,
    );
  }

  // ── BFS: multi-source shortest-hop depth from `origins`, capped at MAX_DEPTH ────────────────
  function bfs(origins: ReadonlySet<string>): Map<string, number> {
    const depth = new Map<string, number>();
    const queue: string[] = [];
    for (const o of [...origins].sort()) {
      // sorted seeding: order-independent (I-5) even though depth values themselves don't
      // depend on visitation order for a plain BFS.
      if (depth.has(o)) continue;
      depth.set(o, 0);
      queue.push(o);
    }
    let qi = 0;
    while (qi < queue.length) {
      const u = queue[qi++]!;
      const d = depth.get(u)!;
      if (d >= MAX_DEPTH) continue;
      for (const v of outboundVouches.get(u) ?? []) {
        if (!depth.has(v)) {
          depth.set(v, d + 1);
          queue.push(v);
        }
      }
    }
    return depth;
  }

  function gate2(id: string, depthMap: Map<string, number>): boolean {
    return distinctContributingVoucherCount(id, depthMap) >= MIN_VOUCHERS;
  }
  function gate3(depth: Map<string, number>, id: string): boolean {
    const d = depth.get(id);
    return d !== undefined && d <= MAX_DEPTH;
  }
  function gate4(id: string): boolean {
    return !hasRecentUpheldReport(id, GATE4_WINDOW_DAYS);
  }

  // ── stage 1: positive human scores — outer origins loop + inner layered pass ───────────────
  const originsSet = new Set<string>(anchorIds);
  const persistedSp = new Map<string, number>();
  for (const id of anchorIds) persistedSp.set(id, ANCHOR);

  // One inner layered pass (depth BFS + per-depth score sum) against a given origin set. Factored
  // out so the post-loop finalization pass below reuses the exact same computation rather than a
  // hand-copy that could drift from it.
  function innerPass(originsForPass: ReadonlySet<string>): { depth: Map<string, number>; sp: Map<string, number> } {
    const passDepth = bfs(originsForPass);
    const passSp = new Map<string, number>();

    for (const id of [...originsForPass].sort()) {
      passSp.set(id, anchorIds.has(id) ? ANCHOR : persistedSp.get(id)!);
    }

    const byDepth = new Map<number, string[]>();
    for (const u of humans) {
      if (originsForPass.has(u.id)) continue;
      const d = passDepth.get(u.id);
      const key = d === undefined ? -1 : d;
      if (!byDepth.has(key)) byDepth.set(key, []);
      byDepth.get(key)!.push(u.id);
    }

    for (const id of byDepth.get(-1) ?? []) {
      passSp.set(id, BASE + tenureOf(accountsById.get(id)!));
    }

    for (let d = 1; d <= MAX_DEPTH; d++) {
      for (const id of byDepth.get(d) ?? []) {
        const acct = accountsById.get(id)!;
        let sum = 0;
        for (const srcId of inboundVouches.get(id) ?? []) {
          const srcDepth = passDepth.get(srcId);
          if (srcDepth === undefined || !(srcDepth < d)) continue;
          sum += weightPos(passSp.get(srcId)!);
        }
        passSp.set(id, BASE + tenureOf(acct) + sum);
      }
    }

    return { depth: passDepth, sp: passSp };
  }

  let depth = new Map<string, number>();
  let sp = new Map<string, number>();
  // True once the outer loop reaches its natural fixed point (a round finds no new origins).
  // False if MAX_ROUNDS was exhausted while the last round *did* still find new origins — in that
  // case `depth`/`sp` are finalized once more below, but the search itself is not re-run (an
  // adversarial input could make that loop forever), so a further downstream promotion that
  // depends on this round's newly-admitted origins may be missing.
  let converged = false;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const pass = innerPass(originsSet);
    depth = pass.depth;
    sp = pass.sp;

    const newOrigins = humans
      .filter((u) => !originsSet.has(u.id))
      .filter((u) => {
        const s = sp.get(u.id)!;
        return s >= T2 && gate2(u.id, depth) && gate3(depth, u.id) && gate4(u.id);
      })
      .map((u) => u.id);

    if (newOrigins.length === 0) {
      converged = true;
      break;
    }
    for (const id of newOrigins) {
      persistedSp.set(id, sp.get(id)!);
      originsSet.add(id);
    }
  }

  if (!converged) {
    // The last iteration admitted new origins but the loop then hit MAX_ROUNDS, so `depth`/`sp`
    // above still reflect the pre-promotion origin set — the just-admitted origins would be
    // published at their stale, pre-origin depth instead of depth 0. This final pass only
    // finalizes bookkeeping for origins already admitted; it does not search for further new
    // origins, and `converged` stays false so a caller can detect and alert on / retry the
    // exhaustion.
    const finalPass = innerPass(originsSet);
    depth = finalPass.depth;
    sp = finalPass.sp;
  }

  // ── stage 2: platform scores (from s⁺ only) ─────────────────────────────────────────────────
  const sPlatform = new Map<string, number>();
  const reportEval = new Map<
    string,
    { valid: boolean; voidReason?: string; baseWeight: number; decayedWeight: number }
  >();

  function isVoidedReporter(id: string): boolean {
    return hasRecentUpheldReport(id, REPORT_DECAY_DAYS);
  }
  function isConflictOfInterest(r: Report): boolean {
    const reporterAcct = accountsById.get(r.reporter);
    if (!reporterAcct || reporterAcct.kind !== "platform") return false;
    return activePlatformVouches.some((pv) => pv.platform === r.reporter && pv.voucher === r.target);
  }
  function platformQueryOk(r: Report): boolean {
    const reporterAcct = accountsById.get(r.reporter);
    if (!reporterAcct || reporterAcct.kind !== "platform") return true; // n/a for human reporters
    return r.queried === true;
  }
  function isPlatformToPlatform(r: Report): boolean {
    return (
      accountsById.get(r.reporter)?.kind === "platform" && accountsById.get(r.target)?.kind === "platform"
    );
  }
  function voidReasonFor(r: Report): string | undefined {
    if (!accountsById.has(r.reporter)) return "reporter_unknown";
    if (!accountsById.has(r.target)) return "target_unknown";
    if (r.state === "rejected") return "report_rejected";
    if (r.state === "withdrawn") return "report_withdrawn";
    // A platform can never report another platform (docs/01-trust-math.md §17 case 4) — otherwise
    // two platforms bootstrap each other's report weight, the clique attack one level up. Checked
    // before any score lookup so voiding never depends on whether the reporter's own sPlatform has
    // been computed yet in the stage-2 loop below, which would make the result order-dependent on
    // account-id sort order.
    if (isPlatformToPlatform(r)) return "platform_cannot_report_platform";
    if (isVoidedReporter(r.reporter)) return "reporter_voided";
    if (isConflictOfInterest(r)) return "platform_conflict_of_interest";
    if (!platformQueryOk(r)) return "platform_did_not_query_subject";
    return undefined;
  }

  function getEval(r: Report) {
    let e = reportEval.get(r.id);
    if (e) return e;
    const reason = voidReasonFor(r);
    if (reason) {
      e = { valid: false, voidReason: reason, baseWeight: 0, decayedWeight: 0 };
    } else {
      const reporterAcct = accountsById.get(r.reporter)!;
      // Reporters targeting a platform are always human (01-trust-math.md §1 edge table), so
      // this sP lookup is only ever exercised for human-targeted reports authored by a platform —
      // by then stage 2 has already finished populating sPlatform for every platform.
      const sourceScore =
        reporterAcct.kind === "platform" ? (sPlatform.get(r.reporter) ?? 0) : sp.get(r.reporter)!;
      // Both terms are required (docs/01-trust-math.md §7.1): never inflict more damage than the
      // bond paid for (snapshotWeight, fixed at filing time), and never more than current standing
      // justifies (the live weight). Using only the live score would let a reporter who files at
      // low standing and is later promoted inflict full current-score damage instead of what they
      // actually bonded for.
      const baseWeight = Math.min(r.snapshotWeight, weightNeg(sourceScore));
      e = { valid: true, baseWeight, decayedWeight: decayedWeight(baseWeight, r, now) };
    }
    reportEval.set(r.id, e);
    return e;
  }

  const platformReportResults = new Map<string, ReportWeightResult>();
  for (const p of platforms) {
    const pos = (platformInbound.get(p.id) ?? []).reduce(
      (acc, pv) => acc + weightPos(sp.get(pv.voucher) ?? BASE),
      0,
    );

    const evaluated = (reportsByTarget.get(p.id) ?? []).map((r) => ({ r, e: getEval(r) }));
    const upheldRanked = evaluated
      .filter((x) => x.r.state === "upheld" && x.e.valid)
      .map((x) => ({ r: x.r, decayedWeight: x.e.decayedWeight }))
      .sort(byIdThenWeightDesc);
    const topScore = new Set(upheldRanked.slice(0, TOP_K).map((x) => x.r.id));
    const anyRanked = evaluated
      .filter((x) => x.e.valid)
      .map((x) => ({ r: x.r, decayedWeight: x.e.decayedWeight }))
      .sort(byIdThenWeightDesc);
    const topRisk = new Set(anyRanked.slice(0, TOP_K).map((x) => x.r.id));

    const neg = upheldRanked
      .slice(0, TOP_K)
      .reduce((acc, x) => acc + x.decayedWeight, 0);
    sPlatform.set(p.id, Math.max(0, pos - neg));

    for (const { r, e } of evaluated) {
      platformReportResults.set(r.id, buildReportResult(r, e, topScore.has(r.id), topRisk.has(r.id)));
    }
  }

  // ── stage 3 + 4: report weights against humans, then final score / scoreAtRisk ─────────────
  const score = new Map<string, number>();
  const scoreAtRisk = new Map<string, number>();
  const humanReportResults = new Map<string, ReportWeightResult>();

  for (const u of humans) {
    const evaluated = (reportsByTarget.get(u.id) ?? []).map((r) => ({ r, e: getEval(r) }));

    if (anchorIds.has(u.id)) {
      // An anchor's score is fixed and ignores every inbound edge — including reports
      // (01-trust-math.md §2). Reports against an anchor are still recorded/valid/visible, just
      // inert.
      score.set(u.id, ANCHOR);
      scoreAtRisk.set(u.id, ANCHOR);
      for (const { r, e } of evaluated) {
        humanReportResults.set(r.id, buildReportResult(r, e, false, false));
      }
      continue;
    }

    const upheldRanked = evaluated
      .filter((x) => x.r.state === "upheld" && x.e.valid)
      .map((x) => ({ r: x.r, decayedWeight: x.e.decayedWeight }))
      .sort(byIdThenWeightDesc);
    const topScore = upheldRanked.slice(0, TOP_K);
    const topScoreIds = new Set(topScore.map((x) => x.r.id));

    const anyRanked = evaluated
      .filter((x) => x.e.valid)
      .map((x) => ({ r: x.r, decayedWeight: x.e.decayedWeight }))
      .sort(byIdThenWeightDesc);
    const topRisk = anyRanked.slice(0, TOP_K);
    const topRiskIds = new Set(topRisk.map((x) => x.r.id));

    const sumUpheld = topScore.reduce((acc, x) => acc + x.decayedWeight, 0);
    const sumRisk = topRisk.reduce((acc, x) => acc + x.decayedWeight, 0);

    const floorVal = BASE + tenureOf(u);
    const sPlusVal = sp.get(u.id)!;
    score.set(u.id, Math.max(floorVal, sPlusVal - sumUpheld));
    scoreAtRisk.set(u.id, Math.max(floorVal, sPlusVal - sumRisk));

    for (const { r, e } of evaluated) {
      humanReportResults.set(
        r.id,
        buildReportResult(r, e, topScoreIds.has(r.id), topRiskIds.has(r.id)),
      );
    }
  }

  // ── stage 5: tiers ───────────────────────────────────────────────────────────────────────────
  //
  // Members of the final `originsSet` (anchors, plus every human promoted to Tier 2 during the
  // outer loop) are classified Tier 2 unconditionally, rather than re-run through gate2/gate3
  // against the *final* depth map. Two reasons:
  //   1. By definition, origins = anchors ∪ Tier 2 (01-trust-math.md §6) — origin membership and
  //      Tier-2 status are the same fact, not two facts that could disagree.
  //   2. Re-checking would be actively wrong: once promoted, an origin is depth 0 in the final
  //      BFS, and gate 2's contributing-voucher count requires depth(voucher) < depth(target) —
  //      nothing has depth < 0, so a re-check would vacuously fail gate 2 for every non-anchor
  //      origin. The gates were already proven, using valid depth data, in the round the origin
  //      loop admitted this account, and the loop only *adds* origins, so that proof is never
  //      invalidated by a later round.
  // Every other human is classified fresh against the final depth map, using gate 2's contributing
  // vouchers (see distinctContributingVoucherCount) and the *published* score (post-report), so a
  // recent upheld report can still cap a high-scoring non-origin at Tier 1 via gate 4, even though
  // gate 4 only ever applies to the Tier-2 decision.
  const tier = new Map<string, Tier>();
  for (const u of humans) {
    if (originsSet.has(u.id)) {
      tier.set(u.id, 2);
      continue;
    }
    const s = score.get(u.id)!;
    const g2 = gate2(u.id, depth);
    const g3 = gate3(depth, u.id);
    if (s >= T2 && g2 && g3 && gate4(u.id)) tier.set(u.id, 2);
    else if (s >= T1 && g2 && g3) tier.set(u.id, 1);
    else tier.set(u.id, 0);
  }

  const platformTier = new Map<string, PlatformTier>();
  for (const p of platforms) {
    const s = sPlatform.get(p.id)!;
    const distinctHumanVouchers = new Set((platformInbound.get(p.id) ?? []).map((pv) => pv.voucher))
      .size;
    const g2 = distinctHumanVouchers >= MIN_VOUCHERS;
    if (s >= P2 && g2) platformTier.set(p.id, 2);
    else if (s >= P1 && g2) platformTier.set(p.id, 1);
    else platformTier.set(p.id, 0);
  }

  // ── assemble output (sorted keys throughout — invariant I-5, order-independent output) ──────
  const depthOut: Record<string, number> = {};
  const sPlusOut: Record<string, number> = {};
  const scoreOut: Record<string, number> = {};
  const scoreAtRiskOut: Record<string, number> = {};
  const tierOut: Record<string, Tier> = {};
  for (const u of humans) {
    depthOut[u.id] = depth.get(u.id) ?? Number.POSITIVE_INFINITY;
    sPlusOut[u.id] = sp.get(u.id)!;
    scoreOut[u.id] = score.get(u.id)!;
    scoreAtRiskOut[u.id] = scoreAtRisk.get(u.id)!;
    tierOut[u.id] = tier.get(u.id)!;
  }

  const sPlatformOut: Record<string, number> = {};
  const platformTierOut: Record<string, PlatformTier> = {};
  for (const p of platforms) {
    sPlatformOut[p.id] = sPlatform.get(p.id)!;
    platformTierOut[p.id] = platformTier.get(p.id)!;
  }

  const reportWeights: Record<string, ReportWeightResult> = {};
  const allReportIds = [...humanReportResults.keys(), ...platformReportResults.keys()].sort();
  for (const id of allReportIds) {
    const result = humanReportResults.get(id) ?? platformReportResults.get(id);
    if (result) reportWeights[id] = result;
  }

  return {
    now,
    origins: [...originsSet].sort(),
    depth: depthOut,
    sPlus: sPlusOut,
    sPlatform: sPlatformOut,
    score: scoreOut,
    scoreAtRisk: scoreAtRiskOut,
    tier: tierOut,
    platformTier: platformTierOut,
    reportWeights,
    converged,
  };
}
