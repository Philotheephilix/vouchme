import { Header } from "@/components/Header";
import { ReportStamp } from "@/components/ReportStamp";
import { StatLine } from "@/components/StatLine";
import { fmtDate, fmtScore } from "@/lib/format";
import { NOW, REPORTS } from "@/lib/mock";
import type { ReportEntry } from "@/lib/types";

function ReportCard({ report }: { report: ReportEntry }) {
  return (
    <div className="overflow-hidden border border-rule p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <div className="truncate-mono max-w-[180px] text-sm text-cream">
            {report.direction === "against" ? report.reporter.ensName : report.target}
          </div>
          <div className="font-mono text-2xs text-graphite">
            {report.direction === "against" ? "reporter" : "target"} · {report.reasonCode}
          </div>
        </div>
        <ReportStamp report={report} now={NOW} />
      </div>
      <StatLine label="Weight" value={fmtScore(report.weight)} />
      <StatLine label="Filed" value={fmtDate(report.filedAt)} />
      {report.upheldAt ? <StatLine label="Upheld" value={fmtDate(report.upheldAt)} /> : null}
      <StatLine label="Decay remaining" value={`${report.decayRemainingPct}%`} />
      {report.challengeDeadline ? <StatLine label="Challenge deadline" value={fmtDate(report.challengeDeadline)} /> : null}
    </div>
  );
}

export default function ReportsPage() {
  const against = REPORTS.filter((r) => r.direction === "against");
  const filed = REPORTS.filter((r) => r.direction === "filed");

  return (
    <div className="space-y-8 pb-8">
      <Header eyebrow="REPORTS" />

      <section className="px-4">
        <h2 className="mb-3 text-2xs uppercase tracking-widest text-graphite">Against you</h2>
        <div className="space-y-3">
          {against.map((r) => (
            <ReportCard key={r.id} report={r} />
          ))}
        </div>
      </section>

      <section className="px-4">
        <h2 className="mb-3 text-2xs uppercase tracking-widest text-graphite">Filed by you</h2>
        <div className="space-y-3">
          {filed.map((r) => (
            <ReportCard key={r.id} report={r} />
          ))}
        </div>
      </section>
    </div>
  );
}
