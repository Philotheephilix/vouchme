import { cookies } from "next/headers";
import { Header } from "@/components/Header";
import { ReportStamp, reportEffectLine } from "@/components/ReportStamp";
import { StatLine } from "@/components/StatLine";
import { readVerifiedAddress } from "@/lib/authSession";
import { fmtDate, fmtScore, truncateMiddle } from "@/lib/format";
import { loadVouchMeData } from "@/lib/mock";
import type { ReportEntry } from "@/lib/types";
import { explorerTxUrl } from "@/lib/worldchain";

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
      <StatLine label="Weight" value={fmtScore(report.weight)} hint={`bonded for ${fmtScore(report.baseWeight)}`} />
      <StatLine label="Filed" value={fmtDate(report.filedAt)} />
      {report.upheldAt ? <StatLine label="Upheld" value={fmtDate(report.upheldAt)} /> : null}
      <StatLine label="Decay remaining" value={`${report.decayRemainingPct}%`} />
      {report.challengeDeadline ? <StatLine label="Challenge deadline" value={fmtDate(report.challengeDeadline)} /> : null}
      {report.bondVouchMe !== null ? <StatLine label="Bond" value={`${report.bondVouchMe.toLocaleString()} VOUCHME`} /> : null}
      <p className="mt-3 text-2xs leading-relaxed text-graphite">{reportEffectLine(report)}</p>
      {report.txHash ? (
        <a
          className="mt-2 block break-all font-mono text-2xs text-graphite underline"
          href={explorerTxUrl(report.txHash)}
          target="_blank"
          rel="noreferrer"
        >
          {truncateMiddle(report.txHash, 26)}
        </a>
      ) : null}
    </div>
  );
}

// LIVE mode reads World Chain on every request — never bake a snapshot into the build.
export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  // "Against you" / "filed by you" only mean something for the signed-in wallet — AppGate already
  // guarantees a session by the time this route is reachable. Verified, not the raw `vouchme_addr`
  // cookie — see src/app/page.tsx's comment on readVerifiedAddress.
  const cookieStore = await cookies();
  const viewingAddress = readVerifiedAddress(cookieStore) ?? undefined;
  if (!viewingAddress) return null;

  const { REPORTS, NOW, reportsAvailable } = await loadVouchMeData(viewingAddress);
  const against = REPORTS.filter((r) => r.direction === "against");
  const filed = REPORTS.filter((r) => r.direction === "filed");

  // `reportsAvailable` is false only when this deployment has no ReportRegistry configured at all.
  // Then — and only then — an empty list means "we never asked", and saying "nothing has been filed
  // against you" would be answering a question nobody put to the chain.
  if (!reportsAvailable) {
    return (
      <div className="pb-8">
        <Header eyebrow="REPORTS" />
        <section className="px-4 pt-10">
          <p className="text-sm leading-relaxed text-cream">Reports aren&apos;t read on this deployment.</p>
          <p className="mt-3 text-2xs leading-relaxed text-graphite">
            No ReportRegistry is configured for this server, so this screen cannot tell you whether anything has
            been filed against you or by you. An empty list here would be a guess, not an answer.
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

      <section className="px-4">
        <p className="text-2xs leading-relaxed text-graphite">
          Filing a report is not wired into this screen: it needs a VOUCHME bond in CredibilityVault before the
          transaction can succeed, and this build has no bonding flow. The attestation a filing needs is served
          by <span className="font-mono">/api/report/attest</span>.
        </p>
      </section>
    </div>
  );
}
