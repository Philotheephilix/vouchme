import { fmtScore, hoursUntil } from "@/lib/format";
import type { ReportEntry } from "@/lib/types";

/** What this report is actually doing to a score, in one sentence, using only what the engine
 *  reported. Every branch is a real distinction the math makes — none of them is decoration:
 *
 *  - a voided report subtracts nothing and says why (`voidReason`);
 *  - a pending report never touches `score`, only `scoreAtRisk` — "an accusation is not a verdict"
 *    (docs/01-trust-math.md §7.5);
 *  - a valid upheld report that is NOT counted is either outside the top-3 (§7.3), or aimed at an
 *    anchor, whose score ignores every inbound edge (errata E-6), or aimed at someone already at
 *    their floor `base + tenure`, which no accusation can reach (errata E-8). */
export function reportEffectLine(report: ReportEntry): string {
  if (!report.valid) {
    return `Voided by the engine${report.voidReason ? ` (${report.voidReason})` : ""} — subtracts nothing.`;
  }
  if (report.status === "pending") {
    return report.countedTowardRisk
      ? `Counted against score-at-risk only (−${fmtScore(report.baseWeight)}). The published score does not move until a verdict.`
      : "Pending, and outside the top-3 by weight, so it moves nothing at all.";
  }
  if (report.status === "decayed") return "Fully decayed — 180 days have passed, so it now subtracts zero.";
  if (report.countedTowardScore) return `Counted: −${fmtScore(report.weight)} from the published score.`;
  return "Upheld, but not subtracted: either it is outside the top-3 by weight, or the target's score is fixed (anchor) or already at its floor.";
}

/** The four terminal verdicts are four different things (errata E-12): UNPROVEN means the
 *  accusation was not substantiated and nobody is punished, MALICIOUS means the reporter was, and
 *  WITHDRAWN means it was never tested at all. The engine collapses all three into `rejected`
 *  because none of them subtracts a point — but stamping "REJECTED" on all three tells the person
 *  reading it the wrong thing about what happened. When the on-chain state is known, it wins. */
export function ReportStamp({ report, now }: { report: ReportEntry; now: Date }) {
  const isPending = report.status === "pending";
  const pendingLabel = `PENDING · ${Math.max(0, Math.round(hoursUntil(report.challengeDeadline ?? report.filedAt, now)))}H LEFT`;
  const upheldLabel = report.status === "decayed" ? "DECAYED · 0 WEIGHT" : `UPHELD -${fmtScore(report.weight)}`;

  const label =
    report.onChainState === "PENDING"
      ? pendingLabel
      : report.onChainState === "ARBITRATION"
        ? "ARBITRATION"
        : report.onChainState === "UPHELD"
          ? upheldLabel
          : report.onChainState === "UNPROVEN"
            ? "UNPROVEN"
            : report.onChainState === "MALICIOUS"
              ? "MALICIOUS"
              : report.onChainState === "WITHDRAWN"
                ? "WITHDRAWN"
                : report.status === "pending"
                  ? pendingLabel
                  : report.status === "upheld" || report.status === "decayed"
                    ? upheldLabel
                    : "REJECTED";

  return (
    <span
      data-testid="report-stamp"
      className="inline-block max-w-full shrink-0 overflow-hidden text-ellipsis whitespace-nowrap px-1.5 py-0.5 font-mono text-2xs uppercase tracking-wide opacity-80"
      style={{
        color: "var(--color-protest)",
        border: `2px ${isPending ? "dashed" : "solid"} var(--color-protest)`,
        borderRadius: "2px",
        transform: "rotate(-3deg)",
        transformOrigin: "center",
      }}
    >
      {label}
    </span>
  );
}
