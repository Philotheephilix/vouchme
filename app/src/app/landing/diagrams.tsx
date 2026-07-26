/**
 * The two figures that carry /landing's argument. Both are plain server-rendered SVG — no canvas,
 * no WebGL, no client boundary, nothing to dispose. Every colour is a token from globals.css, and
 * node colour is taken from `--color-tier-0/1/2` so a node's tier is legible before its number is
 * read.
 *
 * They are a matched pair and are meant to be read side by side:
 *
 *   DepthPath  — a real path out of two Orb anchors. Every edge crosses a depth boundary, so every
 *                edge has a term in the sum. Scores are the fixture graph's own: anchors 100,
 *                alice/bob 20 + 20 + 20 = 60, carol 20 + 15 + 15 = 50.
 *   DepthRing  — six accounts vouching for each other. Every edge is valid and active. None of them
 *                crosses a boundary, because there is no member at lower depth to cross toward, so
 *                the sum has no terms and every member stays at the enrolment floor of 20.
 *
 * The dashed horizontal line means the same thing in both, and the same thing it means everywhere
 * else on the page: a depth boundary.
 */

const W = 440;
const H = 372;

const INK = "var(--color-cream)";
/* `--color-graphite` at 11–14px sits under the text-contrast floor on paper, and the labels inside
   these figures are content, not decoration. `--lp-muted` is the same token pulled toward ink until
   it clears AA; it is declared on `.page` in landing.module.css. Hairlines keep the light token. */
const MUTED = "var(--lp-muted)";
const ACCENT = "var(--color-accent)";
const RULE = "var(--color-rule-strong)";
/* the ghosted punchline in the ring figure — lighter than MUTED, but it is 22px display type, so it
   still clears the large-text threshold */
const GHOST = "color-mix(in oklab, var(--color-graphite) 82%, var(--color-cream))";

/** Pull a segment's endpoints in along its own axis, so a line starts and ends clear of its nodes. */
function trim(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  padStart: number,
  padEnd: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return {
    x1: x1 + ux * padStart,
    y1: y1 + uy * padStart,
    x2: x2 - ux * padEnd,
    y2: y2 - uy * padEnd,
  };
}

interface NodeSpec {
  cx: number;
  cy: number;
  name: string;
  score: string;
  stroke: string;
  fill: string;
}

const NODE_W = 112;
const NODE_H = 52;

function Node({ cx, cy, name, score, stroke, fill }: NodeSpec) {
  return (
    <g>
      <rect
        x={cx - NODE_W / 2}
        y={cy - NODE_H / 2}
        width={NODE_W}
        height={NODE_H}
        rx={14}
        fill={fill}
        stroke={stroke}
        strokeWidth={1.5}
      />
      <text x={cx} y={cy - 6} textAnchor="middle" fill={MUTED} fontFamily="var(--font-mono)" fontSize={11}>
        {name}
      </text>
      <text
        x={cx}
        y={cy + 15}
        textAnchor="middle"
        fill={INK}
        fontFamily="var(--font-mono)"
        fontSize={17}
        fontWeight={500}
      >
        {score}
      </text>
    </g>
  );
}

/* ── figure 1: a path out of the anchors ────────────────────────────────────────────────────── */

const ROW = { d0: 52, d1: 186, d2: 320 } as const;
const RULE_Y = { one: 119, two: 253 } as const;
const COL = { left: 108, right: 288, mid: 198 } as const;

export function DepthPath({ className }: { className?: string }) {
  const edges = [
    // both anchors reach both members — four boundary crossings, +20 each (0.25 × 100, capped at 20)
    { x1: COL.left, y1: ROW.d0 + NODE_H / 2, x2: COL.left, y2: ROW.d1 - NODE_H / 2 },
    { x1: COL.right, y1: ROW.d0 + NODE_H / 2, x2: COL.left, y2: ROW.d1 - NODE_H / 2 },
    { x1: COL.left, y1: ROW.d0 + NODE_H / 2, x2: COL.right, y2: ROW.d1 - NODE_H / 2 },
    { x1: COL.right, y1: ROW.d0 + NODE_H / 2, x2: COL.right, y2: ROW.d1 - NODE_H / 2 },
    // both members reach carol — two crossings, +15 each (0.25 × 60, under the cap)
    { x1: COL.left, y1: ROW.d1 + NODE_H / 2, x2: COL.mid, y2: ROW.d2 - NODE_H / 2 },
    { x1: COL.right, y1: ROW.d1 + NODE_H / 2, x2: COL.mid, y2: ROW.d2 - NODE_H / 2 },
  ];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} role="img" aria-labelledby="lpPathTitle lpPathDesc">
      <title id="lpPathTitle">A path out of two Orb anchors</title>
      <desc id="lpPathDesc">
        Two anchors at depth 0, each scoring 100. Both vouch for alice and bob at depth 1, who each score 60. Alice and
        bob both vouch for carol at depth 2, who scores 50. Every vouch crosses a depth boundary, so every vouch counts.
      </desc>

      <defs>
        <marker id="lpArrowPath" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill={ACCENT} />
        </marker>
      </defs>

      {/* depth axis */}
      <line x1={32} y1={18} x2={32} y2={354} stroke={RULE} strokeWidth={1} strokeDasharray="1 4" />
      {(["d0", "d1", "d2"] as const).map((d, i) => (
        <text
          key={d}
          x={6}
          y={[ROW.d0, ROW.d1, ROW.d2][i] + 4}
          fill={MUTED}
          fontFamily="var(--font-mono)"
          fontSize={11}
          letterSpacing="0.04em"
        >
          {d}
        </text>
      ))}

      {/* the boundaries, and what one crossing is worth */}
      {(
        [
          { y: RULE_Y.one, label: "each crossing  +20" },
          { y: RULE_Y.two, label: "each crossing  +15" },
        ] as const
      ).map((r) => (
        <g key={r.y}>
          <line x1={40} y1={r.y} x2={428} y2={r.y} stroke={RULE} strokeWidth={1} strokeDasharray="5 5" />
          <text x={428} y={r.y - 8} textAnchor="end" fill={ACCENT} fontFamily="var(--font-mono)" fontSize={11}>
            {r.label}
          </text>
        </g>
      ))}

      {edges.map((e, i) => {
        const t = trim(e.x1, e.y1, e.x2, e.y2, 4, 6);
        return (
          <line
            key={i}
            x1={t.x1}
            y1={t.y1}
            x2={t.x2}
            y2={t.y2}
            stroke={ACCENT}
            strokeWidth={1.6}
            markerEnd="url(#lpArrowPath)"
          />
        );
      })}

      {/* tier 2 — Orb anchors, fixed at 100, depth 0 */}
      <Node
        cx={COL.left}
        cy={ROW.d0}
        name="anchor1"
        score="100"
        stroke="var(--color-tier-2)"
        fill="var(--color-anchor-subtle)"
      />
      <Node
        cx={COL.right}
        cy={ROW.d0}
        name="anchor2"
        score="100"
        stroke="var(--color-tier-2)"
        fill="var(--color-anchor-subtle)"
      />
      {/* tier 1 — 20 + 20 + 20 */}
      <Node cx={COL.left} cy={ROW.d1} name="alice" score="60" stroke="var(--color-tier-1)" fill="var(--color-seal-subtle)" />
      <Node cx={COL.right} cy={ROW.d1} name="bob" score="60" stroke="var(--color-tier-1)" fill="var(--color-seal-subtle)" />
      {/* tier 0 still — 20 + 15 + 15 */}
      <Node cx={COL.mid} cy={ROW.d2} name="carol" score="50" stroke={RULE} fill="var(--color-paper-2)" />
    </svg>
  );
}

/* ── figure 2: a ring that vouches for itself ───────────────────────────────────────────────── */

const RING_CX = 222;
const RING_CY = 250;
const RING_R = 92;
const RING_NODE_R = 21;
const RING_RULE_Y = 104;

export function DepthRing({ className }: { className?: string }) {
  const points = Array.from({ length: 6 }, (_, i) => {
    const a = (-90 + i * 60) * (Math.PI / 180);
    return { x: RING_CX + Math.cos(a) * RING_R, y: RING_CY + Math.sin(a) * RING_R };
  });

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} role="img" aria-labelledby="lpRingTitle lpRingDesc">
      <title id="lpRingTitle">Six accounts vouching for each other in a ring</title>
      <desc id="lpRingDesc">
        Six accounts each vouch for the next. No member of the ring has a path to an anchor, so no member sits at a lower
        depth than any other. Every edge contributes zero, the sum is zero, and all six stay at the enrolment floor of
        20.
      </desc>

      <defs>
        <marker id="lpArrowRing" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="5.5" markerHeight="5.5" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill={MUTED} />
        </marker>
      </defs>

      {/* the region above the boundary, and what is in it */}
      <text x={RING_CX} y={50} textAnchor="middle" fill={MUTED} fontFamily="var(--font-mono)" fontSize={11}>
        everyone at lower depth
      </text>
      <text x={RING_CX} y={78} textAnchor="middle" fill={GHOST} fontFamily="var(--font-mono)" fontSize={22} fontWeight={500}>
        nobody
      </text>

      <line x1={40} y1={RING_RULE_Y} x2={428} y2={RING_RULE_Y} stroke={RULE} strokeWidth={1} strokeDasharray="5 5" />
      <text x={428} y={RING_RULE_Y - 8} textAnchor="end" fill={MUTED} fontFamily="var(--font-mono)" fontSize={11}>
        0 crossings
      </text>

      {points.map((p, i) => {
        const q = points[(i + 1) % 6];
        const t = trim(p.x, p.y, q.x, q.y, RING_NODE_R + 5, RING_NODE_R + 9);
        // push the label out past the ring so it never sits on top of an edge
        const mx = (p.x + q.x) / 2;
        const my = (p.y + q.y) / 2;
        const rx = mx - RING_CX;
        const ry = my - RING_CY;
        const rl = Math.hypot(rx, ry) || 1;
        return (
          <g key={i}>
            <line
              x1={t.x1}
              y1={t.y1}
              x2={t.x2}
              y2={t.y2}
              stroke={MUTED}
              strokeWidth={1.4}
              markerEnd="url(#lpArrowRing)"
            />
            <text
              x={mx + (rx / rl) * 21}
              y={my + (ry / rl) * 21 + 4}
              textAnchor="middle"
              fill={MUTED}
              fontFamily="var(--font-mono)"
              fontSize={11}
            >
              +0
            </text>
          </g>
        );
      })}

      {points.map((p, i) => (
        <g key={`n${i}`}>
          <circle cx={p.x} cy={p.y} r={RING_NODE_R} fill="var(--color-paper-2)" stroke={RULE} strokeWidth={1.5} />
          <text
            x={p.x}
            y={p.y + 5}
            textAnchor="middle"
            fill={MUTED}
            fontFamily="var(--font-mono)"
            fontSize={14}
            fontWeight={500}
          >
            20
          </text>
        </g>
      ))}

      <text
        x={RING_CX}
        y={RING_CY + 2}
        textAnchor="middle"
        fill={MUTED}
        fontFamily="var(--font-mono)"
        fontSize={22}
        fontWeight={500}
      >
        Σ = 0
      </text>
      <text x={RING_CX} y={RING_CY + 24} textAnchor="middle" fill={MUTED} fontFamily="var(--font-mono)" fontSize={11}>
        from 6 active vouches
      </text>
    </svg>
  );
}
