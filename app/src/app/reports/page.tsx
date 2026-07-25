import { cookies } from "next/headers";
import { Header } from "@/components/Header";
import { ReportStamp } from "@/components/ReportStamp";
import { StatLine } from "@/components/StatLine";
import { readVerifiedAddress } from "@/lib/authSession";
import { fmtDate, fmtScore, truncateMiddle } from "@/lib/format";
import { loadAvalData } from "@/lib/mock";
import type { ReportEntry } from "@/lib/types";

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
  // guarantees a session by the time this route is reachable. Verified, not the raw `aval_addr`
  // cookie (docs/96-ux-audit.md U-24) — see src/app/page.tsx's comment on readVerifiedAddress.
  const cookieStore = await cookies();
  const viewingAddress = readVerifiedAddress(cookieStore) ?? undefined;
  if (!viewingAddress) return null;

  const { REPORTS, NOW, reportsAvailable } = await loadAvalData(viewingAddress);
  const against = REPORTS.filter((r) => r.direction === "against");
  const filed = REPORTS.filter((r) => r.direction === "filed");

  // This build never reads ReportRegistry — `chain.ts` constructs its EngineInput with
  // `reports: []`. Two empty section headers therefore stated "no reports against you" on the
  // strength of a question that was never asked. Say which.
  if (!reportsAvailable) {
    return (
      <div className="pb-8">
        <Header eyebrow="REPORTS" />
        <section className="px-4 pt-10">
          <p className="text-sm leading-relaxed text-cream">Reports aren&apos;t read on this deployment yet.</p>
          <p className="mt-3 text-2xs leading-relaxed text-graphite">
            ReportRegistry is deployed, but this app does not query it, so this screen cannot tell you whether
            anything has been filed against you or by you. An empty list here would be a guess, not an answer.
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-8">
      <Header eyebrow="REPORTS" />

      <section className="px-4">
        <h2 className="mb-3 text-2xs uppercase tracking-widest text-graphite">Against you</h2>
        <div className="space-y-3">
          {against.length === 0 ? (
            <p className="text-2xs text-graphite">Nothing has been filed against you.</p>
          ) : (
            against.map((r) => <ReportCard key={r.id} report={r} now={NOW} />)
          )}
        </div>
      </section>

      <section className="px-4">
        <h2 className="mb-3 text-2xs uppercase tracking-widest text-graphite">Filed by you</h2>
        <div className="space-y-3">
          {filed.length === 0 ? (
            <p className="text-2xs text-graphite">You haven&apos;t filed a report.</p>
          ) : (
            filed.map((r) => <ReportCard key={r.id} report={r} now={NOW} />)
          )}
        </div>
      </section>
    </div>
  );
}
