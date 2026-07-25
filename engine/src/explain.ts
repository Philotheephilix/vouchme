/**
 * Aval — human-readable score explanations.
 *
 * This is a product surface, not a debug aid: "why is my score what it is" has to answer for
 * every inbound edge, including the ones that contribute nothing — a legal voucher excluded only
 * by depth ordering still gets a row showing its raw contribution. `breakdown()` returns one row
 * per inbound vouch and per report against the account, each with a `counted` flag and, when
 * `counted` is false, the specific reason why not.
 */

import type {
  Account,
  AccountKind,
  EngineInput,
  EngineOutput,
  PlatformTier,
  Report,
  ReportState,
  Tier,
} from "./types.js";
import { BASE } from "./constants.js";
import { tenureCenti } from "./tenure.js";
// Import the real contribution formula rather than duplicating its constants as bare literals,
// and the same canonical-edge dedup `compute()` uses, so a duplicated (voucher, vouchee) record
// shows up as exactly one row here too.
import { dedupeVouches, weightPos } from "./score.js";

export type VoucherNotCountedReason =
  | "anchor_ignores_inbound"
  | "vouch_inactive"
  | "voucher_not_human"
  | "voucher_unreachable"
  | "voucher_depth_not_lower";

export interface VoucherRow {
  voucher: string;
  /** The voucher's own positive score at the time of this computation, centi-points. `undefined`
   *  if the voucher account is missing or not human. */
  voucherSPlus: number | undefined;
  /** BFS depth of the voucher; `undefined` if missing/not human/unreachable. */
  voucherDepth: number | undefined;
  /** The raw contribution this vouch WOULD make — min(voucherSPlus × 0.25, cap), centi-points.
   *  Shown even when `counted` is false. */
  rawContribution: number;
  /** What actually landed in the vouchee's s⁺ sum: `rawContribution` if counted, else 0. */
  contribution: number;
  counted: boolean;
  reason: VoucherNotCountedReason | "counted";
}

export type ReportNotCountedReason =
  | "anchor_ignores_inbound"
  | "reporter_unknown"
  | "target_unknown"
  | "report_rejected"
  | "report_withdrawn"
  | "reporter_voided"
  | "platform_conflict_of_interest"
  | "platform_did_not_query_subject"
  | "platform_cannot_report_platform"
  | "decayed_to_zero"
  | "outside_top_k"
  | "pending_not_upheld";

export interface ReportRow {
  reportId: string;
  reporter: string;
  state: ReportState;
  baseWeight: number;
  /** Weight after §7.4 linear decay — what top-K ranking and subtraction actually use. */
  decayedWeight: number;
  valid: boolean;
  /** Counted against the published `score` (upheld reports, top-K only). */
  countedTowardScore: boolean;
  /** Counted against `scoreAtRisk` (upheld + pending, top-K only). */
  countedTowardRisk: boolean;
  reason: ReportNotCountedReason | "counted";
}

export interface ScoreBreakdown {
  address: string;
  kind: AccountKind;
  isAnchor: boolean;
  /** BASE, centi-points — everyone's floor before tenure and vouches. Humans only. */
  base: number;
  /** Tenure bonus, centi-points. 0 for platforms. */
  tenure: number;
  /** BASE + tenure — the score floor no report can cross. `undefined` for platforms (base_P = 0,
   *  no floor at all — docs/01-trust-math.md §8). */
  floor: number | undefined;
  depth: number;
  sPlus: number | undefined;
  sPlatform: number | undefined;
  score: number | undefined;
  scoreAtRisk: number | undefined;
  tier: Tier | undefined;
  platformTier: PlatformTier | undefined;
  vouchers: VoucherRow[];
  platformVouchers: VoucherRow[];
  reports: ReportRow[];
}

function fmt(centi: number): string {
  if (!Number.isFinite(centi)) return centi > 0 ? "∞" : "-∞";
  const sign = centi < 0 ? "-" : "";
  const abs = Math.abs(centi);
  const whole = Math.trunc(abs / 100);
  const frac = abs % 100;
  return `${sign}${whole}.${String(frac).padStart(2, "0")}`;
}

function reportReason(
  rw: EngineOutput["reportWeights"][string] | undefined,
  targetIsAnchor: boolean,
): ReportNotCountedReason | "counted" {
  if (targetIsAnchor) return "anchor_ignores_inbound";
  if (!rw) return "target_unknown";
  if (!rw.valid) return (rw.voidReason as ReportNotCountedReason) ?? "target_unknown";
  if (rw.countedTowardScore || rw.countedTowardRisk) return "counted";
  if (rw.decayedWeight === 0) return "decayed_to_zero";
  return "outside_top_k";
}

/**
 * Structured, row-by-row breakdown of one account's score: every inbound vouch and every report
 * against it, each with a `counted` flag and — when not counted — the reason why. Needs `input`
 * because `EngineOutput` deliberately carries no edge-level detail (only aggregates).
 */
export function breakdown(address: string, input: EngineInput, output: EngineOutput): ScoreBreakdown {
  const accountsById = new Map<string, Account>();
  for (const a of input.accounts) accountsById.set(a.id, a);
  const self = accountsById.get(address);
  const kind: AccountKind = self?.kind ?? "human";
  const isAnchor = self?.isAnchor === true;

  const depth = output.depth[address] ?? Number.POSITIVE_INFINITY;
  const tenure = kind === "human" ? tenureCenti(self?.epochsClaimed ?? 0) : 0;

  const vouchers: VoucherRow[] = dedupeVouches(input.vouches)
    .filter((v) => v.vouchee === address)
    .map((v) => {
      const voucherAcct = accountsById.get(v.voucher);
      if (!v.active) {
        return {
          voucher: v.voucher,
          voucherSPlus: undefined,
          voucherDepth: undefined,
          rawContribution: 0,
          contribution: 0,
          counted: false,
          reason: "vouch_inactive" as const,
        };
      }
      if (!voucherAcct || voucherAcct.kind !== "human") {
        return {
          voucher: v.voucher,
          voucherSPlus: undefined,
          voucherDepth: undefined,
          rawContribution: 0,
          contribution: 0,
          counted: false,
          reason: "voucher_not_human" as const,
        };
      }
      const voucherSPlus = output.sPlus[v.voucher];
      const voucherDepth = output.depth[v.voucher];
      const rawContribution = voucherSPlus === undefined ? 0 : weightPos(voucherSPlus);

      if (isAnchor) {
        return {
          voucher: v.voucher,
          voucherSPlus,
          voucherDepth,
          rawContribution,
          contribution: 0,
          counted: false,
          reason: "anchor_ignores_inbound" as const,
        };
      }
      if (voucherDepth === undefined || !Number.isFinite(voucherDepth)) {
        return {
          voucher: v.voucher,
          voucherSPlus,
          voucherDepth,
          rawContribution,
          contribution: 0,
          counted: false,
          reason: "voucher_unreachable" as const,
        };
      }
      if (!(voucherDepth < depth)) {
        return {
          voucher: v.voucher,
          voucherSPlus,
          voucherDepth,
          rawContribution,
          contribution: 0,
          counted: false,
          reason: "voucher_depth_not_lower" as const,
        };
      }
      return {
        voucher: v.voucher,
        voucherSPlus,
        voucherDepth,
        rawContribution,
        contribution: rawContribution,
        counted: true,
        reason: "counted" as const,
      };
    });

  const platformVouchers: VoucherRow[] = input.platformVouches
    .filter((pv) => pv.platform === address)
    .map((pv) => {
      const voucherAcct = accountsById.get(pv.voucher);
      if (!pv.active || !voucherAcct || voucherAcct.kind !== "human") {
        const reason: "vouch_inactive" | "voucher_not_human" = !pv.active
          ? "vouch_inactive"
          : "voucher_not_human";
        return {
          voucher: pv.voucher,
          voucherSPlus: undefined,
          voucherDepth: undefined,
          rawContribution: 0,
          contribution: 0,
          counted: false,
          reason,
        };
      }
      const voucherSPlus = output.sPlus[pv.voucher];
      const rawContribution = voucherSPlus === undefined ? 0 : weightPos(voucherSPlus);
      return {
        voucher: pv.voucher,
        voucherSPlus,
        voucherDepth: output.depth[pv.voucher],
        rawContribution,
        contribution: rawContribution,
        counted: true,
        reason: "counted" as const,
      };
    });

  const reports: ReportRow[] = input.reports
    .filter((r: Report) => r.target === address)
    .map((r) => {
      const rw = output.reportWeights[r.id];
      return {
        reportId: r.id,
        reporter: r.reporter,
        state: r.state,
        baseWeight: rw?.baseWeight ?? 0,
        decayedWeight: rw?.decayedWeight ?? 0,
        valid: rw?.valid ?? false,
        countedTowardScore: rw?.countedTowardScore ?? false,
        countedTowardRisk: rw?.countedTowardRisk ?? false,
        reason: reportReason(rw, isAnchor),
      };
    });

  return {
    address,
    kind,
    isAnchor,
    base: kind === "human" ? BASE : 0,
    tenure,
    floor: kind === "human" ? BASE + tenure : undefined,
    depth,
    sPlus: output.sPlus[address],
    sPlatform: output.sPlatform[address],
    score: output.score[address],
    scoreAtRisk: output.scoreAtRisk[address],
    tier: output.tier[address],
    platformTier: output.platformTier[address],
    vouchers,
    platformVouchers,
    reports,
  };
}

/**
 * Prose explanation of one account's score, built entirely from `EngineOutput` (no edge-level
 * detail — use `breakdown()` for that). Deterministic, pure string formatting.
 */
export function explain(address: string, output: EngineOutput): string {
  const isPlatform = output.sPlatform[address] !== undefined && output.sPlus[address] === undefined;

  if (isPlatform) {
    const sP = output.sPlatform[address]!;
    const tier = output.platformTier[address];
    const lines = [
      `${address} is a platform with score ${fmt(sP)} (Tier P${tier ?? 0}).`,
      `Platforms have no floor (base_P = 0): the score is exactly the sum of what humans vouch, minus upheld reports.`,
    ];
    return lines.join(" ");
  }

  const sPlus = output.sPlus[address];
  if (sPlus === undefined) {
    return `${address} is not present in this computation.`;
  }
  const score = output.score[address]!;
  const scoreAtRisk = output.scoreAtRisk[address]!;
  const tier = output.tier[address]!;
  const depth = output.depth[address];

  const lines: string[] = [];

  lines.push(
    `${address} has a positive score s⁺ of ${fmt(sPlus)}` +
      (depth !== undefined && Number.isFinite(depth) ? ` at graph depth ${depth}.` : ", unreachable from any origin."),
  );

  const reportsAgainst = Object.values(output.reportWeights).filter((r) => r.target === address);
  const upheldCounted = reportsAgainst.filter((r) => r.countedTowardScore);
  const pendingCounted = reportsAgainst.filter((r) => r.countedTowardRisk && !r.countedTowardScore);

  if (upheldCounted.length > 0) {
    const total = upheldCounted.reduce((acc, r) => acc + r.decayedWeight, 0);
    lines.push(
      `${upheldCounted.length} upheld report(s) currently count against it, removing ${fmt(total)} points.`,
    );
  } else {
    lines.push(`No upheld reports currently count against it.`);
  }

  if (pendingCounted.length > 0) {
    const total = pendingCounted.reduce((acc, r) => acc + r.decayedWeight, 0);
    lines.push(
      `${pendingCounted.length} pending report(s) would additionally remove ${fmt(total)} points if upheld — reflected only in scoreAtRisk.`,
    );
  }

  lines.push(
    `Final score is ${fmt(score)} (scoreAtRisk ${fmt(scoreAtRisk)}), placing it at Tier ${tier}.`,
  );

  if (score === sPlus - upheldCounted.reduce((acc, r) => acc + r.decayedWeight, 0) && score > 0) {
    // no floor clamp happened; nothing further to say
  } else if (upheldCounted.length > 0) {
    lines.push(`The score floor (base + tenure) protected it from falling further.`);
  }

  return lines.join(" ");
}
