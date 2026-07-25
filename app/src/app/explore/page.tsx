import { Header } from "@/components/Header";
import { TierBadge } from "@/components/TierBadge";
import { anchorSourceLabel, dropAvalSuffix, fmtScore, truncateMiddle } from "@/lib/format";
import { loadAvalData } from "@/lib/mock";
import type { ExploreScenario } from "@/lib/types";

function ScenarioColumn({ scenario }: { scenario: ExploreScenario }) {
  const color = scenario.finalTier > 0 ? "var(--color-seal)" : "var(--color-graphite)";
  const sortedNodes = [...scenario.nodes].sort((a, b) => (a.depth ?? 99) - (b.depth ?? 99));

  return (
    <div className="flex-1">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-mono text-2xs uppercase tracking-widest text-graphite">{scenario.exhibit}</span>
        <span className="font-mono text-lg" style={{ color }}>
          {fmtScore(scenario.finalScore)}
        </span>
      </div>
      <h2 className="text-sm text-cream">{scenario.label}</h2>
      <p className="mt-1 text-2xs leading-relaxed text-graphite">{scenario.description}</p>

      <div className="mt-4">
        {sortedNodes.map((node) => (
          <div key={node.ensName} className="flex items-center justify-between border-b border-rule py-2">
            <span className="min-w-0 flex-1">
              <span className="truncate-mono block max-w-[150px] text-xs text-cream">{truncateMiddle(node.ensName, 20)}</span>
              {node.isAnchor ? (
                <span className="block font-mono text-2xs uppercase tracking-wide" style={{ color: "var(--color-anchor)" }}>
                  {anchorSourceLabel(node.anchorSource)}
                </span>
              ) : null}
            </span>
            <span className="flex items-center gap-2">
              <span className="font-mono text-2xs text-graphite">
                depth {node.depth ?? "∞"} · {fmtScore(node.score)}
              </span>
              <TierBadge tier={node.tier} />
            </span>
          </div>
        ))}
      </div>

      <div className="mt-4">
        {/* every name below shares the .aval.eth suffix (or, in the ring, .eth) — dropped here so
            the column reads "anchor1 → alice" instead of repeating it on every row. Each end gets
            its own flex-basis and its own middle-out ellipsis, so a long target can never eat into
            the source's space (or vice versa) the way one shared CSS ellipsis on a single string
            would — that was the original bug: the *target*, the actual information, is what got
            cut. */}
        <div className="mb-1 font-mono text-2xs uppercase tracking-widest text-graphite">Edges</div>
        {scenario.edges.map((edge) => (
          <div key={`${edge.from}->${edge.to}`} className="flex items-center gap-2 py-1">
            <span className="flex min-w-0 flex-1 items-center gap-1 font-mono text-2xs text-graphite">
              <span className="truncate-mono min-w-0 flex-1">{truncateMiddle(dropAvalSuffix(edge.from), 11)}</span>
              <span aria-hidden="true" className="shrink-0">
                →
              </span>
              <span className="truncate-mono min-w-0 flex-1 text-cream">
                {truncateMiddle(dropAvalSuffix(edge.to), 11)}
              </span>
            </span>
            <span
              className="shrink-0 font-mono text-2xs"
              style={{ color: edge.counted ? "var(--color-seal)" : "var(--color-graphite)" }}
            >
              {edge.counted ? `+${edge.contribution.toFixed(1)}` : "blocked"}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// LIVE mode reads World Chain Sepolia on every request — never bake a snapshot into the build.
export const dynamic = "force-dynamic";

export default async function ExplorePage() {
  const { EXPLORE_HONEST, EXPLORE_RING } = await loadAvalData();
  return (
    <div className="pb-8">
      <Header eyebrow="EXPLORE" title="honest path vs. collusion ring" />

      <section className="grid grid-cols-1 gap-8 px-4 pt-6 md:grid-cols-[1fr_auto_1fr] md:gap-6">
        <ScenarioColumn scenario={EXPLORE_HONEST} />
        <div className="flex items-center justify-center border-t border-rule py-3 md:border-l md:border-t-0 md:px-3 md:py-0">
          <span className="whitespace-nowrap font-mono text-2xs uppercase tracking-widest text-graphite">
            Exhibit A / Exhibit B
          </span>
        </div>
        <ScenarioColumn scenario={EXPLORE_RING} />
      </section>
    </div>
  );
}
