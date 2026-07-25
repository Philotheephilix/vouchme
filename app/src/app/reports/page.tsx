import { cookies } from "next/headers";
import { isAddress } from "viem";
import { Header } from "@/components/Header";
import { ReportStamp } from "@/components/ReportStamp";
import { StatLine } from "@/components/StatLine";
import { fmtDate, fmtScore, truncateMiddle } from "@/lib/format";
import { loadAvalData } from "@/lib/mock";
import type { Address, ReportEntry } from "@/lib/types";

function ReportCard({ report, now }: { report: ReportEntry; now: Date }) {
  return (
    <div className="overflow-hidden border border-rule p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate-mono max-w-[180px] text-sm text-cream">
            {truncateMiddle(report.direction === "against" ? report.reporter.ensName : report.target, 22)}
          </div>
          <div className="break-words font-mono text-2xs text-graphite">
            {report.direction === "against" ? "reporter" : "target"} · {report.reasonCode}
          </div>
        </div>
        <ReportStamp report={report} now={now} />
      </div>
      <StatLine label="Weight" value={fmtScore(report.weight)} />
      <StatLine label="Filed" value={fmtDate(report.filedAt)} />
      {report.upheldAt ? <StatLine label="Upheld" value={fmtDate(report.upheldAt)} /> : null}
      <StatLine label="Decay remaining" value={`${report.decayRemainingPct}%`} />
      {report.challengeDeadline ? <StatLine label="Challenge deadline" value={fmtDate(report.challengeDeadline)} /> : null}
    </div>
  );
}

// LIVE mode reads World Chain Sepolia on every request — never bake a snapshot into the build.
export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  // "Against you" / "filed by you" only mean something for the signed-in wallet — AppGate already
  // guarantees a session by the time this route is reachable.
  const cookieStore = await cookies();
  const cookieAddr = cookieStore.get("aval_addr")?.value;
  const viewingAddress = cookieAddr && isAddress(cookieAddr) ? (cookieAddr as Address) : undefined;
  if (!viewingAddress) return null;

  const { REPORTS, NOW } = await loadAvalData(viewingAddress);
  const against = REPORTS.filter((r) => r.direction === "against");
  const filed = REPORTS.filter((r) => r.direction === "filed");

  return (
    <div className="space-y-8 pb-8">
      <Header eyebrow="REPORTS" />

      <section className="px-4">
        <h2 className="mb-3 text-2xs uppercase tracking-widest text-graphite">Against you</h2>
        <div className="space-y-3">
          {against.map((r) => (
            <ReportCard key={r.id} report={r} now={NOW} />
          ))}
        </div>
      </section>

      <section className="px-4">
        <h2 className="mb-3 text-2xs uppercase tracking-widest text-graphite">Filed by you</h2>
        <div className="space-y-3">
          {filed.map((r) => (
            <ReportCard key={r.id} report={r} now={NOW} />
          ))}
        </div>
      </section>
    </div>
  );
}
