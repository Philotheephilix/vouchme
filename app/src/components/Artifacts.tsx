/**
 * Poster artifacts — a set of bold geometric marks lifted from Swiss-poster / HUD reference:
 * concentric rings, radial sunbursts, petal starbursts, crosshairs, bracket corners and halftone
 * dot fields. Every mark is stroked/filled in `currentColor` and marked aria-hidden, so it inherits
 * its surroundings and never announces itself to assistive tech. They exist to give surfaces life —
 * a faint blue watermark behind a header, a burst behind a hero, a bracket framing an empty state —
 * not to carry meaning. Keep them scarce and let the ink do the talking.
 */
import type { CSSProperties } from "react";

interface MarkProps {
  size?: number;
  className?: string;
  style?: CSSProperties;
  /** stroke weight for line-based marks */
  weight?: number;
}

const base = (size: number): CSSProperties => ({ display: "block", flex: "none" });

/** Concentric rings — the MC2 target motif. `rings` sets how many; they thin toward the edge. */
export function ConcentricRings({ size = 120, rings = 7, weight = 2, className, style }: MarkProps & { rings?: number }) {
  const c = size / 2;
  const step = (c - weight) / rings;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" aria-hidden className={className} style={{ ...base(size), ...style }}>
      {Array.from({ length: rings }, (_, i) => (
        <circle key={i} cx={c} cy={c} r={step * (i + 1)} stroke="currentColor" strokeWidth={weight} />
      ))}
    </svg>
  );
}

/** Solid bullseye — filled disc with a punched centre ring. The poster's heavy dot. */
export function Bullseye({ size = 80, className, style }: MarkProps) {
  const c = size / 2;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" aria-hidden className={className} style={{ ...base(size), ...style }}>
      <circle cx={c} cy={c} r={c} fill="currentColor" />
      <circle cx={c} cy={c} r={c * 0.44} fill="var(--color-void, #fff)" />
      <circle cx={c} cy={c} r={c * 0.16} fill="currentColor" />
    </svg>
  );
}

/** Sunburst — dense thin rays from a hub, the poster's big radiating disc. */
export function Sunburst({ size = 140, rays = 72, weight = 1.4, className, style }: MarkProps & { rays?: number }) {
  const c = size / 2;
  const inner = c * 0.06;
  const outer = c - weight;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" aria-hidden className={className} style={{ ...base(size), ...style }}>
      {Array.from({ length: rays }, (_, i) => {
        const a = (i / rays) * Math.PI * 2;
        return (
          <line
            key={i}
            x1={c + Math.cos(a) * inner}
            y1={c + Math.sin(a) * inner}
            x2={c + Math.cos(a) * outer}
            y2={c + Math.sin(a) * outer}
            stroke="currentColor"
            strokeWidth={weight}
          />
        );
      })}
    </svg>
  );
}

/** Starburst — a sharp N-point asterisk star (the poster's spark mark). */
export function Starburst({ size = 90, points = 8, weight = 2, className, style }: MarkProps & { points?: number }) {
  const c = size / 2;
  const rO = c - weight;
  const rI = c * 0.14;
  const pts: string[] = [];
  for (let i = 0; i < points * 2; i++) {
    const a = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? rO : rI;
    pts.push(`${c + Math.cos(a) * r},${c + Math.sin(a) * r}`);
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" aria-hidden className={className} style={{ ...base(size), ...style }}>
      <polygon points={pts.join(" ")} fill="currentColor" />
    </svg>
  );
}

/** Petal flower — the poster's rounded-lobe bloom, built from N circles on a ring. */
export function Petals({ size = 90, petals = 8, className, style }: MarkProps & { petals?: number }) {
  const c = size / 2;
  const ring = c * 0.52;
  const r = c * 0.34;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" aria-hidden className={className} style={{ ...base(size), ...style }}>
      {Array.from({ length: petals }, (_, i) => {
        const a = (i / petals) * Math.PI * 2;
        return <circle key={i} cx={c + Math.cos(a) * ring} cy={c + Math.sin(a) * ring} r={r} fill="currentColor" />;
      })}
      <circle cx={c} cy={c} r={c * 0.3} fill="var(--color-void, #fff)" />
    </svg>
  );
}

/** Radial fan — a spray of rays across an arc, HUD-kit style (open, not a full disc). */
export function RadialFan({ size = 120, rays = 22, spread = 150, weight = 1.4, className, style }: MarkProps & { rays?: number; spread?: number }) {
  const ox = size * 0.5;
  const oy = size * 0.9;
  const len = size * 0.82;
  const start = (-90 - spread / 2) * (Math.PI / 180);
  const stepR = (spread * (Math.PI / 180)) / (rays - 1);
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" aria-hidden className={className} style={{ ...base(size), ...style }}>
      {Array.from({ length: rays }, (_, i) => {
        const a = start + stepR * i;
        return <line key={i} x1={ox} y1={oy} x2={ox + Math.cos(a) * len} y2={oy + Math.sin(a) * len} stroke="currentColor" strokeWidth={weight} />;
      })}
    </svg>
  );
}

/** Crosshair — ringed cross with tick marks. The HUD alignment reticle. */
export function Crosshair({ size = 88, weight = 1.6, className, style }: MarkProps) {
  const c = size / 2;
  const r = c * 0.62;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" aria-hidden className={className} style={{ ...base(size), ...style }}>
      <circle cx={c} cy={c} r={r} stroke="currentColor" strokeWidth={weight} />
      <circle cx={c} cy={c} r={c * 0.09} fill="currentColor" />
      {[0, 90, 180, 270].map((deg) => {
        const a = (deg * Math.PI) / 180;
        return (
          <line
            key={deg}
            x1={c + Math.cos(a) * (r - c * 0.16)}
            y1={c + Math.sin(a) * (r - c * 0.16)}
            x2={c + Math.cos(a) * (c - weight)}
            y2={c + Math.sin(a) * (c - weight)}
            stroke="currentColor"
            strokeWidth={weight}
          />
        );
      })}
    </svg>
  );
}

/** Bracket corners — four HUD framing L's. Absolutely-positioned overlay for a card/box. */
export function Corners({ size = 14, weight = 1.5, className, style }: MarkProps) {
  const s = size;
  const w = weight;
  const corner = (d: string, k: string) => (
    <path key={k} d={d} stroke="currentColor" strokeWidth={w} fill="none" strokeLinecap="square" vectorEffect="non-scaling-stroke" />
  );
  return (
    <svg width="100%" height="100%" viewBox="0 0 100 100" preserveAspectRatio="none" fill="none" aria-hidden className={className} style={{ position: "absolute", inset: 0, pointerEvents: "none", ...style }}>
      <g>
        {corner(`M0 ${s} V0 H${s}`, "tl")}
        {corner(`M${100 - s} 0 H100 V${s}`, "tr")}
        {corner(`M100 ${100 - s} V100 H${100 - s}`, "br")}
        {corner(`M${s} 100 H0 V${100 - s}`, "bl")}
      </g>
    </svg>
  );
}

/** Halftone dot field — a grid of dots that fade toward one edge, the poster's texture block. */
export function DotField({ size = 120, cols = 9, className, style, fade = true }: MarkProps & { cols?: number; fade?: boolean }) {
  const gap = size / cols;
  const r = gap * 0.22;
  const dots = [];
  for (let y = 0; y < cols; y++) {
    for (let x = 0; x < cols; x++) {
      const op = fade ? 1 - (x / cols) * 0.85 : 1;
      dots.push(<circle key={`${x}-${y}`} cx={gap * (x + 0.5)} cy={gap * (y + 0.5)} r={r} fill="currentColor" opacity={op} />);
    }
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} fill="none" aria-hidden className={className} style={{ ...base(size), ...style }}>
      {dots}
    </svg>
  );
}

/** Diagonal slashes — the poster's // and \\ tick pairs, a quick energetic accent. */
export function Slashes({ size = 40, count = 3, weight = 3, className, style }: MarkProps & { count?: number }) {
  const gap = size / (count + 1);
  return (
    <svg width={size} height={size * 0.7} viewBox={`0 0 ${size} ${size * 0.7}`} fill="none" aria-hidden className={className} style={{ ...base(size), ...style }}>
      {Array.from({ length: count }, (_, i) => (
        <line key={i} x1={gap * (i + 1) - size * 0.14} y1={size * 0.6} x2={gap * (i + 1) + size * 0.14} y2={size * 0.08} stroke="currentColor" strokeWidth={weight} strokeLinecap="round" />
      ))}
    </svg>
  );
}
