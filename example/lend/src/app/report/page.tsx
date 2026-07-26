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
          Lend reports as a <strong>registered platform</strong>, not as you. VouchMe only permits that against someone
          Lend has actually looked up — the lookup is recorded on chain as an attributed ScoreRequest before the report
          is filed, because a platform cannot report a person it never dealt with.
        </p>

        {!configured ? (
          <p className="error">
            Reporting is not configured: <code>LEND_PLATFORM_PRIVATE_KEY</code> is unset. Run{" "}
            <code>scripts/seed-lendme-platform.mjs</code> and set the key it prints.
          </p>
        ) : !registered ? (
          <p className="error">
            {platform ? short(platform) : "Lend"} is not a registered platform on this deployment, so it cannot report
            anyone yet. Run <code>scripts/seed-lendme-platform.mjs</code> against the deployment this app points at.
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
          <p className="empty">
            Nothing filed yet. This log lives in Lend&apos;s memory and is lost on restart — the authoritative record is
            the <code>ReportFiled</code> event on World Chain, which no restart can touch.
          </p>
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

      <p className="foot">
        A report takes away vouched standing, never the fact that someone is a live human — that is attested by World ID,
        so no accusation reaches it.
      </p>
    </main>
  );
}
