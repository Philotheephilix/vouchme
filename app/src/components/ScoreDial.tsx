import { fmtScore, tierLabel } from "@/lib/format";
import type { Tier } from "@/lib/types";

interface ScoreDialProps {
  score: number;
  tier: Tier;
  /** counted vouches — drawn as ticks around the ring, a calm density cue, never a blob */
  countedVouchCount: number;
  size?: number;
}

const TIER_COLOR: Record<Tier, string> = {
  0: "var(--color-tier-0)",
  1: "var(--color-tier-1)",
  2: "var(--color-tier-2)",
};

/**
 * A clean progress ring — hairline track, one tier-coloured arc that sweeps in on mount, the score
 * as the hero figure at the centre. The arc length is a visual density cue (`score` toward a full
 * ring), not a claim about distance to a threshold.
 */
export function ScoreDial({ score, tier, countedVouchCount, size = 176 }: ScoreDialProps) {
  const stroke = 6;
  const r = 50 - stroke / 2;
  const circumference = 2 * Math.PI * r;
  const fraction = Math.min(1, Math.max(0.04, score / 100));
  const color = TIER_COLOR[tier];
  const [whole, frac = "0"] = fmtScore(score).split(".");

  const ticks = Math.min(24, countedVouchCount);

  return (
    <div data-testid="score-dial" className="relative mx-auto" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size} className="block -rotate-90" aria-hidden="true">
        <circle cx="50" cy="50" r={r} fill="none" stroke="var(--color-rule)" strokeWidth={stroke} />
        <circle
          className="ring-arc"
          cx="50"
          cy="50"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          style={{ ["--ring-circumference" as string]: circumference }}
        />
        {Array.from({ length: ticks }, (_, i) => {
          const a = (i / 24) * 2 * Math.PI;
          const inner = r - stroke;
          return (
            <line
              key={i}
              x1={50 + Math.cos(a) * inner}
              y1={50 + Math.sin(a) * inner}
              x2={50 + Math.cos(a) * (inner - 3)}
              y2={50 + Math.sin(a) * (inner - 3)}
              stroke={color}
              strokeWidth={0.8}
              strokeLinecap="round"
              opacity={0.5}
            />
          );
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div data-testid="score-figure" className="flex items-baseline font-bold text-cream">
          <span style={{ fontSize: size * 0.3, lineHeight: 1, letterSpacing: "-0.04em" }}>{whole}</span>
          <span className="font-mono text-graphite" style={{ fontSize: size * 0.12 }}>
            .{frac}
          </span>
        </div>
        <div className="badge badge-outline mt-2" style={{ color }}>
          {tier > 0 ? <span className="dot" /> : null}
          {tierLabel(tier)}
        </div>
      </div>
    </div>
  );
}
