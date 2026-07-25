import { cookies } from "next/headers";
import { Header } from "@/components/Header";
import { StatLine } from "@/components/StatLine";
import { TierBadge } from "@/components/TierBadge";
import { readVerifiedAddress } from "@/lib/authSession";
import { fmtScore, truncateMiddle } from "@/lib/format";
import { loadAvalData } from "@/lib/mock";

// LIVE mode reads World Chain Sepolia on every request — never bake a snapshot into the build.
export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const cookieStore = await cookies();
  // docs/96-ux-audit.md U-24, same fix as src/app/page.tsx: `aval_addr` is client-writable and is
  // display-only. Authorization comes from `readVerifiedAddress`, which returns an address only
  // when its session was minted after a real wallet signature was verified server-side.
  const viewingAddress = readVerifiedAddress(cookieStore) ?? undefined;
  if (!viewingAddress) return null;

  const { AGENT } = await loadAvalData(viewingAddress);
  return (
    <div className="pb-8">
      {/* The header used to read `trader.<your handle>` as though that agent existed. It does
          not: nobody chose the label "trader", nothing was registered, and no name was reserved
          (docs/96-ux-audit.md U-9). The page title now names the subject honestly and the example
          name is labelled as an example everywhere it appears below. */}
      <Header eyebrow="AGENTS" title="agent subnames — preview" />

      <section className="px-4 pt-6">
        <StatLine label="Operator" value={truncateMiddle(AGENT.operator, 24)} />
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

        {/* Agent subname registration hasn't shipped (no ENSIP-26/25 registrar call exists yet —
            /api/ens/mint only mints the operator's own `<handle>.aval.eth`, never a subname like
            this). Everything below is real, live-computed data about what WOULD be published,
            not a record that exists on ENS today. Say so plainly, once, right where the fabricated
            hostnames start — docs/96-ux-audit.md U-9, matching Explore's "ANCHOR: GENESIS
            (TESTNET)" tone rather than pretending mcp.aval.xyz / a2a.aval.xyz are live. */}
        <div className="mt-6 border px-3 py-2" style={{ borderColor: "var(--color-rule)" }}>
          <p className="font-mono text-2xs uppercase tracking-widest text-graphite">Preview — not yet published</p>
          <p className="mt-1 text-2xs leading-relaxed text-graphite">
            Agent subname registration hasn&apos;t shipped, and you can&apos;t choose a name yet. The records below
            are composed with the example label{" "}
            <span className="font-mono text-cream">{AGENT.exampleLabel}</span>, giving{" "}
            <span className="font-mono text-cream">{AGENT.subname}</span> — nobody has reserved that name, and none
            of these records are minted, resolvable, or reachable today.
          </p>
        </div>

        <div className="mt-6">
          <div className="mb-2 font-mono text-2xs uppercase tracking-widest text-graphite">ENSIP-26 records</div>
          <div className="scroll-x">
            {Object.entries(AGENT.ensip26).map(([key, value]) => (
              <div key={key} className="border-b border-rule py-2.5 last:border-b-0">
                <div className="font-mono text-2xs text-graphite">{key}</div>
                <div className="mt-1 whitespace-pre-wrap font-mono text-xs text-cream">{value}</div>
                {key.startsWith("agent-endpoint") ? (
                  <div className="mt-1 font-mono text-2xs uppercase tracking-widest text-graphite">
                    Not deployed — this host does not resolve
                  </div>
                ) : null}
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

        {/* No mint path exists for agent subnames today, so the control must not look pressable —
            docs/96-ux-audit.md U-9: "a dead button as an action" reads as broken. Disabled, with
            the reason printed under it (not just a hover `title`) so it's visible on a touch
            screen too. */}
        <button
          type="button"
          disabled
          title="Agent subname minting is not deployed yet."
          className="mt-8 min-h-[44px] w-full border px-4 py-3 font-mono text-xs uppercase tracking-widest disabled:opacity-40"
          style={{ borderColor: "var(--color-graphite)", color: "var(--color-graphite)" }}
        >
          Mint an agent subname
        </button>
        <p className="mt-2 text-center text-2xs text-graphite">
          Not available yet — agent subname minting hasn&apos;t shipped. Your handle, {AGENT.operator}, is already
          live.
        </p>
      </section>
    </div>
  );
}
