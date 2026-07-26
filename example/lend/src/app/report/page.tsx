import { cookies } from "next/headers";
import Link from "next/link";
import { ReportForm } from "@/components/ReportForm";
import { SignIn } from "@/components/SignIn";
import { platformAddress, platformRegistered, reportingConfigured } from "@/lib/platform";
import { listReports } from "@/lib/reports";
import { reasonLabel } from "@/lib/reasons";
import { readVerifiedAddress } from "@/lib/session";

// Whether Lend may report at all is live chain state, and so is the report log's meaning. A cached
// page here would offer a form against a deployment that has since changed.
export const dynamic = "force-dynamic";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default async function ReportPage() {
  const address = readVerifiedAddress(await cookies());
  const configured = reportingConfigured();
  // Read live rather than assumed: without registration every report is a bare revert, and the
  // honest thing is to say so before the form is filled in, not after it is submitted.
  const registered = configured ? await platformRegistered().catch(() => false) : false;
  const platform = platformAddress();
  const reports = listReports();

  return (
    <main className="shell">
      <header className="masthead">
        <h1 className="wordmark">Lend</h1>
        <span className="unit">REPORT</span>
      </header>

      <nav className="nav">
        <Link className="btn btn-quiet" href="/">
          ← Pools
        </Link>
      </nav>

      <section aria-label="File a report">
        <p className="bond-note">
          Lend reports as a <strong>registered platform</strong>, not as you. The lookup is recorded on chain before the
          report is filed.
        </p>

        {!configured ? (
          <p className="error">
            <code>LEND_PLATFORM_PRIVATE_KEY</code> is unset, so Lend cannot report.
          </p>
        ) : !registered ? (
          <p className="error">
            {platform ? short(platform) : "Lend"} is not a registered platform on this deployment.
          </p>
        ) : null}

        {address ? null : (
          <div style={{ margin: "0 0 1rem" }}>
            <SignIn />
          </div>
        )}

        {configured && registered ? <ReportForm signedIn={Boolean(address)} /> : null}
      </section>

      <section aria-label="Reports Lend has filed" style={{ marginTop: "2rem" }}>
        <span className="label">Filed by Lend</span>
        {reports.length === 0 ? (
          <p className="empty">Nothing filed yet.</p>
        ) : (
          <div className="reports">
            {reports.map((r) => (
              <article className="report" key={r.fileTxHash}>
                <div className="report-head">
                  <span className="report-subject">{r.ensName ?? short(r.target)}</span>
                  <span className="chip">{reasonLabel(r.reasonCode)}</span>
                </div>
                <p className="report-meta">
                  weight {(r.weightPoints / 100).toFixed(2)} · reported as “{r.subjectInput}” ·{" "}
                  {new Date(r.at).toISOString().slice(0, 16).replace("T", " ")}
                </p>
                {r.note ? <p className="report-note">{r.note}</p> : null}
                <p className="report-meta">
                  <a href={`https://worldscan.org/tx/${r.fileTxHash}`} target="_blank" rel="noreferrer">
                    {short(r.fileTxHash)}
                  </a>
                </p>
              </article>
            ))}
          </div>
        )}
      </section>

      <p className="foot">A report removes vouched standing, never proof of personhood.</p>
    </main>
  );
}
