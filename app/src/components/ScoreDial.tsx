import { fmtScore, tierLabel } from "@/lib/format";
import type { Tier } from "@/lib/types";

interface ScoreDialProps {
  score: number;
  tier: Tier;
  /** drives petal count — the number of vouches that actually counted toward this score */
  countedVouchCount: number;
  size?: number;
}

const TIER_COLOR: Record<Tier, string> = {
  0: "var(--color-tier-0)",
  1: "var(--color-tier-1)",
  2: "var(--color-tier-2)",
};

/**
 * A guilloché rosette (hypotrochoid), the security-print engraving found on banknotes and bonds.
 *
 *   x(t) = cx + (R - r)*cos(t) + a*cos(((R - r)/r)*t)
 *   y(t) = cy + (R - r)*sin(t) - a*sin(((R - r)/r)*t)
 *
 * `petals` is chosen so r = R/(petals+1), which makes (R - r)/r land on exactly `petals` — an
 * integer — so the curve always closes after a single t in [0, 2*PI]. Real engine-turned rosettes
 * run high petal counts (dozens of fine lobes, never a 2- or 3-lobe blob), so the count is kept in
 * the 7..23 band regardless of how few vouches are behind it.
 */
function guillochePath(R: number, petals: number, ampFactor: number, cx: number, cy: number, samples: number): string {
  const r = R / (petals + 1);
  const k = (R - r) / r;
  const a = r * ampFactor;
  const parts: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = (i / samples) * Math.PI * 2;
    const x = cx + (R - r) * Math.cos(t) + a * Math.cos(k * t);
    const y = cy + (R - r) * Math.sin(t) - a * Math.sin(k * t);
    parts.push(`${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`);
  }
  return `${parts.join(" ")} Z`;
}

const SAMPLES = 1440;
// engine-turned guilloché is never a single outline — real security print stacks many rosettes,
// each nudged in phase and amplitude, so their crossings read as a woven mesh rather than a stack
// of outlines. Layer 0 is front-most.
const LAYERS = 6;
// each layer back from the front loses ~6% of the front layer's amplitude, so the mesh tightens
// toward the centre instead of every strand tracing the same band.
const AMP_STEP = 0.94;

export function ScoreDial({ score, tier, countedVouchCount, size = 200 }: ScoreDialProps) {
  const cx = 100;
  const cy = 100;
  // banknote-engraving petal density: more counted vouches -> a busier rosette, but never a blob.
  const petals = Math.min(23, Math.max(7, 7 + countedVouchCount * 2));
  // The floor is high on purpose: gentle scalloping is too soft for a phase-shifted copy to
  // visibly cross, so the mesh blurs into one fuzzy line. Pronounced points make the back layers
  // weave across the front one. Capped below 1.0 (a < r) so the curve never loops back on itself.
  const ampFactor = Math.min(0.9, Math.max(0.55, 0.4 + score / 100));
  // Sized so the rosette fills the 200x200 viewBox rather than floating in a wide empty margin.
  const R = 84;
  const color = TIER_COLOR[tier];
  const [whole, frac = "0"] = fmtScore(score).split(".");

  // f: 0 at the front layer, 1 at the back-most layer — every per-layer visual property is a
  // lerp along this axis, so "further back" always and only ever means "thinner + fainter".
  const lerp = (from: number, to: number, f: number): number => from + (to - from) * f;

  const layers = Array.from({ length: LAYERS }, (_, i) => {
    const f = i / (LAYERS - 1);
    const amp = ampFactor * AMP_STEP ** i;
    return {
      i,
      d: guillochePath(R, petals, amp, cx, cy, SAMPLES),
      rotationDeg: i * (360 / (petals * LAYERS)),
      isFront: i === 0,
      strokeWidth: lerp(0.45, 0.3, f),
      opacity: lerp(1, 0.2, f),
    };
  });

  return (
    <div data-testid="score-dial" className="relative mx-auto" style={{ width: size, height: size }}>
      <svg viewBox="0 0 200 200" width={size} height={size} className="block" aria-hidden="true">
        {/* back-to-front so the front (tier-coloured, full-amplitude) layer paints on top and the
            crossings underneath read as engraving rather than a flat stack of outlines. */}
        {[...layers].reverse().map((layer) => (
          <path
            key={layer.i}
            d={layer.d}
            fill="none"
            stroke={layer.isFront ? color : "var(--color-rule)"}
            strokeWidth={layer.strokeWidth}
            opacity={layer.opacity}
            vectorEffect="non-scaling-stroke"
            transform={`rotate(${layer.rotationDeg} ${cx} ${cy})`}
            className={layer.isFront ? "guilloche-path" : undefined}
          />
        ))}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div data-testid="score-figure" className="flex items-baseline text-cream">
          <span className="font-serif" style={{ fontSize: "var(--text-3xl)", lineHeight: 1 }}>
            {whole}
          </span>
          <span className="font-mono" style={{ fontSize: "var(--text-xl)" }}>
            .{frac}
          </span>
        </div>
        <div className="mt-2 font-mono text-2xs uppercase tracking-widest" style={{ color }}>
          {tierLabel(tier)}
        </div>
      </div>
    </div>
  );
}
