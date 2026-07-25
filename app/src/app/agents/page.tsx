import { Header } from "@/components/Header";
import { StatLine } from "@/components/StatLine";
import { TierBadge } from "@/components/TierBadge";
import { fmtScore } from "@/lib/format";
import { AGENT } from "@/lib/mock";

export default function AgentsPage() {
  return (
    <div className="pb-8">
      <Header eyebrow="AGENTS" title={AGENT.subname} />

      <section className="px-4 pt-6">
        <StatLine label="Operator" value={AGENT.operator} />
        <StatLine label="Operator score" value={fmtScore(AGENT.operatorScore)} />

        <div className="border-b border-rule py-2.5">
          <span className="text-sm text-graphite">Inherited tier</span>
          <div className="mt-1">
            <TierBadge tier={AGENT.inheritedTier} />
          </div>
        </div>

        <div className="mt-4 border px-4 py-3" style={{ borderColor: "var(--color-anchor)" }}>
          <p className="text-sm leading-relaxed text-cream">
            This agent inherits your{" "}
            <span className="font-mono" style={{ color: "var(--color-anchor)" }}>
              Tier {AGENT.inheritedTier}
            </span>
            . It can never exceed it, and it can never vouch for anyone.
          </p>
        </div>

        <div className="mt-6">
          <div className="mb-2 font-mono text-2xs uppercase tracking-widest text-graphite">ENSIP-26 records</div>
          <div className="scroll-x">
            {Object.entries(AGENT.ensip26).map(([key, value]) => (
              <div key={key} className="border-b border-rule py-2.5 last:border-b-0">
                <div className="font-mono text-2xs text-graphite">{key}</div>
                <div className="mt-1 whitespace-pre-wrap font-mono text-xs text-cream">{value}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-6">
          <div className="mb-2 font-mono text-2xs uppercase tracking-widest text-graphite">ENSIP-25 registration</div>
          <div className="scroll-x">
            <code className="whitespace-nowrap font-mono text-xs text-cream">{AGENT.ensip25RegistrationKey}</code>
          </div>
        </div>

        <button
          type="button"
          className="mt-8 min-h-[44px] w-full border px-4 py-3 font-mono text-xs uppercase tracking-widest"
          style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
        >
          Mint {AGENT.subname}
        </button>
      </section>
    </div>
  );
}
