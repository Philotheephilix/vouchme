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

export function ScoreDial({ score, tier, countedVouchCount, size = 220 }: ScoreDialProps) {
  const cx = 100;
  const cy = 100;
  // banknote-engraving petal density: more counted vouches -> a busier rosette, but never a blob.
  const petals = Math.min(23, Math.max(7, 7 + countedVouchCount * 2));
  const ampFactor = Math.min(0.95, Math.max(0.15, score / 100));
  const frontPath = guillochePath(78, petals, ampFactor, cx, cy, SAMPLES);
  // second rosette: same radius, slightly softer amplitude, counter-rotated by half a petal so the
  // two engravings interleave rather than trace one another — the interference pattern is the point.
  const backPath = guillochePath(78, petals, ampFactor * 0.82, cx, cy, SAMPLES);
  const backRotationDeg = 180 / petals;
  const color = TIER_COLOR[tier];
  const [whole, frac = "0"] = fmtScore(score).split(".");

  return (
    <div data-testid="score-dial" className="relative mx-auto" style={{ width: size, height: size }}>
      <svg viewBox="0 0 200 200" width={size} height={size} className="block" aria-hidden="true">
        <path
          d={backPath}
          fill="none"
          stroke="var(--color-rule)"
          strokeWidth={0.45}
          vectorEffect="non-scaling-stroke"
          transform={`rotate(${backRotationDeg} ${cx} ${cy})`}
        />
        <path
          d={frontPath}
          fill="none"
          stroke={color}
          strokeWidth={0.55}
          vectorEffect="non-scaling-stroke"
          className="guilloche-path"
        />
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
