import { cookies } from "next/headers";
import { Header } from "@/components/Header";
import { StatLine } from "@/components/StatLine";
import { readVerifiedAddress } from "@/lib/authSession";
import { fmtVouchMe, fmtPct, fmtScore, platformTierLabel } from "@/lib/format";
import { loadVouchMeData } from "@/lib/mock";
import { Presence } from "@/components/illustrations";

// LIVE mode reads World Chain on every request — never bake a snapshot into the build.
export const dynamic = "force-dynamic";

/** A metric with no source in this mode renders as a stated gap, never as `0` — a zero is a
 *  measurement, and none of these were measured. */
function unknownOr(value: number | null, format: (n: number) => string): string {
  return value === null ? "not tracked" : format(value);
}

export default async function PlatformPage() {
  // Signed out ⇒ render nothing before the chain read, so its payload never reaches a client with
  // no session. Same gate as /explore.
  const cookieStore = await cookies();
  const viewingAddress = readVerifiedAddress(cookieStore) ?? undefined;
  if (!viewingAddress) return null;

  const { PLATFORM, platformsAvailable } = await loadVouchMeData(viewingAddress);

  // No platform on this graph. In live mode that is because PlatformRegistry is never read at
  // all, so rendering the console's zeros and FAILing gates here would print measurements that
  // were never taken as results.
  if (!PLATFORM.registered) {
    return (
      <div className="pb-8">
        <Header eyebrow="PLATFORM CONSOLE" title="Platform console" />
        <section className="px-4 pt-10">
          <div className="mb-5 flex justify-center text-graphite anim-rise-bounce">
            <Presence size={188} />
          </div>
          <p className="text-sm leading-relaxed text-cream">No platform is registered on this deployment.</p>
          <p className="mt-3 text-2xs leading-relaxed text-graphite">
            {platformsAvailable
              ? "PlatformRegistry has no registered platform, so there is no score, bond or gate result to show."
              : "This build does not read PlatformRegistry, so it cannot tell you whether one is registered — it is not showing you an empty console, it is telling you it did not look."}
          </p>
        </section>
      </div>
    );
  }

  return (
    <div className="pb-8">
      <Header eyebrow="PLATFORM CONSOLE" title={PLATFORM.ensName} mono subtitle="Read-only ops view." />

      <section className="px-4 pt-6">
        <div className="mb-6 flex items-baseline justify-between border-b border-rule pb-4">
          <span className="font-medium text-cream" style={{ fontSize: "var(--text-2xl)", letterSpacing: "-0.02em" }}>
            {fmtScore(PLATFORM.score)}
          </span>
          <span
            className="border px-1.5 py-0.5 font-mono text-2xs uppercase tracking-widest"
            style={{ color: "var(--color-anchor)", borderColor: "var(--color-anchor)" }}
          >
            {platformTierLabel(PLATFORM.tier)}
          </span>
        </div>

        <StatLine label="Vouchers" value={String(PLATFORM.voucherCount)} hint="distinct humans" />
        <StatLine label="Bond posted" value={unknownOr(PLATFORM.bondVouchMe, fmtVouchMe)} hint="CredibilityVault" />
        <StatLine label="Requests, last 30d" value={unknownOr(PLATFORM.requestsLast30d, String)} hint="gateway" />
        <StatLine
          label="Upheld rate"
          value={unknownOr(PLATFORM.upheldRatePct, fmtPct)}
          hint="of reports it has filed"
        />

        <div className="mt-6">
          <div className="mb-2 eyebrow">Gates</div>
          <StatLine
            label="Score threshold"
            value={PLATFORM.gates.g1ScoreThreshold ? "PASS" : "FAIL"}
            valueColor={PLATFORM.gates.g1ScoreThreshold ? "var(--color-seal)" : "var(--color-protest)"}
          />
          <StatLine
            label="2 distinct vouchers"
            value={PLATFORM.gates.g2TwoDistinctVouchers ? "PASS" : "FAIL"}
            valueColor={PLATFORM.gates.g2TwoDistinctVouchers ? "var(--color-seal)" : "var(--color-protest)"}
          />
          {/* A gate whose input was never read is not a FAIL. */}
          <StatLine
            label="Bond posted, unslashed"
            value={PLATFORM.gates.g3BondPosted === null ? "NOT CHECKED" : PLATFORM.gates.g3BondPosted ? "PASS" : "FAIL"}
            valueColor={
              PLATFORM.gates.g3BondPosted === null
                ? "var(--color-graphite)"
                : PLATFORM.gates.g3BondPosted
                  ? "var(--color-seal)"
                  : "var(--color-protest)"
            }
          />
        </div>
      </section>
    </div>
  );
}
