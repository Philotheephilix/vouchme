import { cookies } from "next/headers";
import { Header } from "@/components/Header";
import { TierBadge } from "@/components/TierBadge";
import { readVerifiedAddress } from "@/lib/authSession";
import { anchorSourceLabel, dropAvalSuffix, fmtScore, truncateMiddle } from "@/lib/format";
import { loadAvalData } from "@/lib/mock";
import type { ExploreScenario } from "@/lib/types";

function ScenarioColumn({ scenario }: { scenario: ExploreScenario }) {
  const color = scenario.finalTier > 0 ? "var(--color-seal)" : "var(--color-graphite)";
  const sortedNodes = [...scenario.nodes].sort((a, b) => (a.depth ?? 99) - (b.depth ?? 99));

  // An exhibit with nothing in it must show nothing — not a score, not a tier, not the narrative.
  if (!scenario.available) {
    return (
      <div className="flex-1">
        <div className="mb-3 font-mono text-2xs uppercase tracking-widest text-graphite">{scenario.exhibit}</div>
        <h2 className="text-sm text-cream">{scenario.label}</h2>
        <p className="mt-1 text-2xs leading-relaxed text-graphite">{scenario.unavailableReason}</p>
      </div>
    );
  }

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
            the source's space, or vice versa, the way one shared CSS ellipsis on a single string
            would. */}
        <div className="mb-1 font-mono text-2xs uppercase tracking-widest text-graphite">Edges</div>
        {scenario.edges.length === 0 ? (
          <p className="py-1 text-2xs text-graphite">No vouches between these accounts yet.</p>
        ) : null}
        {scenario.edges.map((edge) => (
          <div key={`${edge.from}->${edge.to}`} className="py-1">
            <div className="flex items-center gap-2">
              <span className="flex min-w-0 flex-1 items-center gap-1 font-mono text-2xs text-graphite">
                <span className="truncate-mono min-w-0 flex-1">{truncateMiddle(dropAvalSuffix(edge.from), 11)}</span>
                <span aria-hidden="true" className="shrink-0">
                  →
                </span>
                <span className="truncate-mono min-w-0 flex-1 text-cream">
                  {truncateMiddle(dropAvalSuffix(edge.to), 11)}
                </span>
              </span>
              {/* Show the contribution (+0.0 when uncounted) and the engine's own reason below,
                  rather than the word "blocked", which reads as an error and explains nothing. */}
              <span
                className="shrink-0 font-mono text-2xs"
                style={{ color: edge.counted ? "var(--color-seal)" : "var(--color-graphite)" }}
              >
                +{edge.contribution.toFixed(1)}
              </span>
            </div>
            {!edge.counted && edge.reason ? (
              <p className="mt-0.5 text-2xs leading-relaxed text-graphite">{edge.reason}</p>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

// LIVE mode reads World Chain Sepolia on every request — never bake a snapshot into the build.
export const dynamic = "force-dynamic";

export default async function ExplorePage() {
  // Signed out ⇒ nothing else renders, on any route. Without this gate the chain read below would
  // ship every member's handle, score, tier and depth in the RSC payload to a client with no
  // cookie at all. Same check the other routes use.
  const cookieStore = await cookies();
  const viewingAddress = readVerifiedAddress(cookieStore) ?? undefined;
  if (!viewingAddress) return null;

  const { EXPLORE_HONEST, EXPLORE_RING } = await loadAvalData(viewingAddress);
  return (
    <div className="pb-8">
      {/* Neutral title: a deployment may have no ring at all, so the columns name themselves. */}
      <Header eyebrow="EXPLORE" title="who reaches an anchor" />

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
