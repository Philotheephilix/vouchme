import { fmtScore, hoursUntil } from "@/lib/format";
import type { ReportEntry } from "@/lib/types";

/** What this report is actually doing to a score, in one sentence, using only what the engine
 *  reported. Every branch is a real distinction the math makes — none of them is decoration:
 *
 *  - a voided report subtracts nothing and says why (`voidReason`);
 *  - a pending report never touches `score`, only `scoreAtRisk` — "an accusation is not a verdict"
 *    (docs/01-trust-math.md §7.5);
 *  - a valid upheld report that is NOT counted is either outside the top-3 (§7.3), or aimed at an
 *    anchor, whose score ignores every inbound edge, or aimed at someone already at their floor
 *    `base + tenure`, which no accusation can reach. */
export function reportEffectLine(report: ReportEntry): string {
  if (!report.valid) {
    return `Voided by the engine${report.voidReason ? ` (${report.voidReason})` : ""} — subtracts nothing.`;
  }
  // `countedTowardRisk` / `countedTowardScore` are TOP-K MEMBERSHIP flags — "the engine selected
  // this report" — not "this changed the number". The engine floors every result at
  // `base + tenure`, so a target already at their floor absorbs the whole subtraction and the
  // published figures are identical with and without the report. Assert a deduction only when the
  // target's own numbers actually differ.
  const risked = report.targetScore !== report.targetScoreAtRisk;
  if (report.status === "pending") {
    if (!report.countedTowardRisk) return "Pending, and outside the top-3 by weight, so it moves nothing at all.";
    return risked
      ? `Counted against score-at-risk only (−${fmtScore(report.baseWeight)}). The published score does not move until a verdict.`
      : `Counted, but it changes nothing: ${fmtScore(report.targetScore)} is already this account's floor, and no accusation reduces someone below the fact that they are a live human.`;
  }
  if (report.status === "decayed") return "Fully decayed — 180 days have passed, so it now subtracts zero.";
  if (report.countedTowardScore) {
    // For an UPHELD report the question is whether the published score sits below the target's
    // positive-only score. `risked` answers a different question (is score-at-risk lower), which is
    // about PENDING accusations, so it cannot stand in here.
    const landed = report.targetSPlus - report.targetScore;
    return landed > 0
      ? `Counted: −${fmtScore(Math.min(report.weight, landed))} from the published score.`
      : `Counted, but the published score is unchanged at ${fmtScore(report.targetScore)} — the target is already at their floor, which no accusation reduces.`;
  }
  return "Upheld, but not subtracted: either it is outside the top-3 by weight, or the target's score is fixed (anchor) or already at its floor.";
}

/** The four terminal verdicts are four different things: UNPROVEN means the accusation was not
 *  substantiated, MALICIOUS means the reporter was, WITHDRAWN means it was never tested. The engine
 *  collapses all three into `rejected`, but stamping "REJECTED" on all three tells the reader the
 *  wrong thing. When the on-chain state is known, it wins. */
export function ReportStamp({ report, now }: { report: ReportEntry; now: Date }) {
  const isPending = report.status === "pending";
  const pendingLabel = `Pending · ${Math.max(0, Math.round(hoursUntil(report.challengeDeadline ?? report.filedAt, now)))}h left`;
  const upheldLabel = report.status === "decayed" ? "Decayed · 0 weight" : `Upheld −${fmtScore(report.weight)}`;

  const label =
    report.onChainState === "PENDING"
      ? pendingLabel
      : report.onChainState === "ARBITRATION"
        ? "Arbitration"
        : report.onChainState === "UPHELD"
          ? upheldLabel
          : report.onChainState === "UNPROVEN"
            ? "Unproven"
            : report.onChainState === "MALICIOUS"
              ? "Malicious"
              : report.onChainState === "WITHDRAWN"
                ? "Withdrawn"
                : report.status === "pending"
                  ? pendingLabel
                  : report.status === "upheld" || report.status === "decayed"
                    ? upheldLabel
                    : "Rejected";

  return (
    <span data-testid="report-stamp" className="badge badge-outline shrink-0 text-protest">
      <span className={`dot${isPending ? " dot-pulse" : ""}`} />
      {label}
    </span>
  );
}
