import { fmtScore, hoursUntil } from "@/lib/format";
import type { ReportEntry } from "@/lib/types";

export function ReportStamp({ report, now }: { report: ReportEntry; now: Date }) {
  const isPending = report.status === "pending";
  const label =
    report.status === "pending"
      ? `PENDING · ${Math.max(0, Math.round(hoursUntil(report.challengeDeadline ?? report.filedAt, now)))}H LEFT`
      : report.status === "upheld"
        ? `UPHELD -${fmtScore(report.weight)}`
        : report.status === "decayed"
          ? "DECAYED · 0 WEIGHT"
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
