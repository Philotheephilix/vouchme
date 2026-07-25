import { cookies } from "next/headers";
import { Header } from "@/components/Header";
import { StatLine } from "@/components/StatLine";
import { readVerifiedAddress } from "@/lib/authSession";
import { fmtAval, fmtPct, fmtScore, platformTierLabel } from "@/lib/format";
import { loadAvalData } from "@/lib/mock";

// LIVE mode reads World Chain on every request — never bake a snapshot into the build.
export const dynamic = "force-dynamic";

/** A metric with no source in this mode renders as a stated gap, never as `0` — a zero is a
 *  measurement, and none of these were measured. */
function unknownOr(value: number | null, format: (n: number) => string): string {
  return value === null ? "not tracked" : format(value);
}

export default async function PlatformPage() {
  // Same signed-out leak as /explore (docs/96-ux-audit.md U-7): this page ran the chain read and
  // shipped its payload to clients with no session.
  const cookieStore = await cookies();
  const viewingAddress = readVerifiedAddress(cookieStore) ?? undefined;
  if (!viewingAddress) return null;

  const { PLATFORM, platformsAvailable } = await loadAvalData(viewingAddress);

  // No platform on this graph. In live mode that is because PlatformRegistry is never read at
  // all, so the previous screen — score 0.0, P0, "Vouchers 0", "Bond posted 0.00 AVAL",
  // "Requests, last 30d 0", "Upheld rate 0%", three FAILing gates — was six measurements that
  // were never taken, printed as results.
  if (!PLATFORM.registered) {
    return (
      <div className="pb-8">
        <Header eyebrow="PLATFORM CONSOLE" />
        <section className="px-4 pt-10">
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
      <Header eyebrow="PLATFORM CONSOLE" title={PLATFORM.ensName} />

      <section className="px-4 pt-6">
        <div className="mb-6 flex items-baseline justify-between border-b border-rule pb-4">
          <span className="font-serif text-cream" style={{ fontSize: "var(--text-2xl)" }}>
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
        <StatLine label="Bond posted" value={unknownOr(PLATFORM.bondAval, fmtAval)} hint="CredibilityVault" />
        <StatLine label="Requests, last 30d" value={unknownOr(PLATFORM.requestsLast30d, String)} hint="gateway" />
        <StatLine
          label="Upheld rate"
          value={unknownOr(PLATFORM.upheldRatePct, fmtPct)}
          hint="of reports it has filed"
        />

        <div className="mt-6">
          <div className="mb-2 font-mono text-2xs uppercase tracking-widest text-graphite">Gates</div>
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
