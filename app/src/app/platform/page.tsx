import { Header } from "@/components/Header";
import { StatLine } from "@/components/StatLine";
import { fmtAval, fmtPct, fmtScore, platformTierLabel } from "@/lib/format";
import { PLATFORM } from "@/lib/mock";

export default function PlatformPage() {
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
        <StatLine label="Bond posted" value={fmtAval(PLATFORM.bondAval)} />
        <StatLine label="Requests, last 30d" value={String(PLATFORM.requestsLast30d)} />
        <StatLine label="Upheld rate" value={fmtPct(PLATFORM.upheldRatePct)} hint="of reports it has filed" />

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
          <StatLine
            label="Bond posted, unslashed"
            value={PLATFORM.gates.g3BondPosted ? "PASS" : "FAIL"}
            valueColor={PLATFORM.gates.g3BondPosted ? "var(--color-seal)" : "var(--color-protest)"}
          />
        </div>
      </section>
    </div>
  );
}
