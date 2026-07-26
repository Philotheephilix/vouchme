/**
 * app/src/components/pitch/RingDiagram.tsx
 *
 * The one picture in the deck, because it is the one idea a picture actually helps: a clique and an
 * anchored path drawn side by side, at the same scale, with real numbers on both.
 *
 * Left  — six accounts vouching for each other in a ring. Every edge points at a peer, never at
 *         somebody of strictly lower depth, so every edge contributes exactly zero. All six sit at
 *         the enrollment floor of 20 forever.
 * Right — two Orb anchors vouch for one person. Each vouch is worth 25% of the voucher's score
 *         capped at 20, so each is worth exactly 20, and 20 + 20 + 20 = 60.
 *
 * Both figures are arithmetic straight out of the two structural rules, not illustration: nothing
 * is drawn here that the engine would not compute.
 *
 * Server component — no hooks, no animation. The deck's whole motion budget is spent on scrolling.
 */

import type { ReactNode } from "react";

const RING_NODES = 6;
const RING_R = 62;
const NODE_R = 19;

interface Pt {
  x: number;
  y: number;
}

/** Trims a segment back by `pad` at both ends so an edge stops at the rim of a node rather than
 *  running underneath it — the arrowhead has to be visible to mean anything. */
function trim(a: Pt, b: Pt, pad: number): { x1: number; y1: number; x2: number; y2: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  return {
    x1: +(a.x + ux * pad).toFixed(2),
    y1: +(a.y + uy * pad).toFixed(2),
    x2: +(b.x - ux * pad).toFixed(2),
    y2: +(b.y - uy * pad).toFixed(2),
  };
}

function Node({ at, label, ink, sub }: { at: Pt; label: string; ink: string; sub?: string }) {
  return (
    <g>
      <circle cx={at.x} cy={at.y} r={NODE_R} fill="var(--color-paper)" stroke={ink} strokeWidth={1.4} />
      <text
        x={at.x}
        y={at.y + 3.5}
        textAnchor="middle"
        fill={ink}
        style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}
      >
        {label}
      </text>
      {sub ? (
        <text
          x={at.x}
          y={at.y + NODE_R + 13}
          textAnchor="middle"
          fill="var(--color-graphite)"
          style={{ fontFamily: "var(--font-sans)", fontSize: 8, fontWeight: 600, letterSpacing: "0.12em" }}
        >
          {sub}
        </text>
      ) : null}
    </g>
  );
}

function Panel({ title, caption, children }: { title: string; caption: string; children: ReactNode }) {
  return (
    <figure className="m-0">
      <figcaption className="eyebrow border-b border-rule pb-2.5">{title}</figcaption>
      <div className="card mt-3 px-2 py-3">{children}</div>
      <p className="mt-2 text-2xs leading-relaxed text-graphite">{caption}</p>
    </figure>
  );
}

export function RingDiagram() {
  const cx = 110;
  const cy = 94;
  const ring: Pt[] = Array.from({ length: RING_NODES }, (_, i) => {
    const t = ((-90 + (360 / RING_NODES) * i) * Math.PI) / 180;
    return { x: +(cx + RING_R * Math.cos(t)).toFixed(2), y: +(cy + RING_R * Math.sin(t)).toFixed(2) };
  });

  const anchorA: Pt = { x: 48, y: 42 };
  const anchorB: Pt = { x: 48, y: 146 };
  const member: Pt = { x: 168, y: 94 };

  return (
    <div className="mt-6 grid gap-6 sm:grid-cols-2">
      <Panel
        title="A ring that vouches for itself"
        caption="Six accounts, six vouches, no anchor. Every voucher sits at the same depth as its target, so every contribution is zero — and wiring all thirty possible edges instead of six changes nothing. Not a detector firing: the sum simply has no terms in it, so there is nothing to tune or evade."
      >
        <svg
          viewBox="0 0 220 196"
          className="mx-auto block h-auto w-full max-w-[215px]"
          role="img"
          aria-label="Six accounts arranged in a ring, each vouching for the next. Every account scores 20.0, the enrollment floor."
        >
          <defs>
            <marker id="pitch-arrow-protest" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="4.5" markerHeight="4.5" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--color-protest)" />
            </marker>
          </defs>
          {ring.map((from, i) => {
            const to = ring[(i + 1) % RING_NODES]!;
            const seg = trim(from, to, NODE_R + 5);
            return (
              <line
                key={`e${i}`}
                {...seg}
                stroke="var(--color-protest)"
                strokeWidth={1.3}
                opacity={0.8}
                markerEnd="url(#pitch-arrow-protest)"
              />
            );
          })}
          {ring.map((at, i) => (
            <Node key={`n${i}`} at={at} label="20.0" ink="var(--color-protest)" />
          ))}
          <text
            x={cx}
            y={cy + 4}
            textAnchor="middle"
            fill="var(--color-graphite)"
            style={{ fontFamily: "var(--font-mono)", fontSize: 11, letterSpacing: "0.06em" }}
          >
            +0.00
          </text>
        </svg>
      </Panel>

      <Panel
        title="A path that starts at an anchor"
        caption="Orb-verified, fixed at 100, depth 0. A vouch is worth 25% of the voucher's score capped at 20 points, so each of these is worth exactly 20. The line underneath is the entire scoring function."
      >
        <svg
          viewBox="0 0 220 196"
          className="mx-auto block h-auto w-full max-w-[215px]"
          role="img"
          aria-label="Two Orb anchors, each scoring 100.0, vouch for one member. Each vouch contributes 20.0, so the member scores 20 base plus 20 plus 20, equals 60.0, Tier 1."
        >
          <defs>
            <marker id="pitch-arrow-seal" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="4.5" markerHeight="4.5" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="var(--color-seal)" />
            </marker>
          </defs>
          {[anchorA, anchorB].map((from, i) => {
            const seg = trim(from, member, NODE_R + 5);
            return (
              <g key={`a${i}`}>
                <line {...seg} stroke="var(--color-seal)" strokeWidth={1.4} markerEnd="url(#pitch-arrow-seal)" />
                <text
                  x={(seg.x1 + seg.x2) / 2}
                  y={(seg.y1 + seg.y2) / 2 + (i === 0 ? -7 : 14)}
                  textAnchor="middle"
                  fill="var(--color-seal)"
                  style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 500 }}
                >
                  +20.0
                </text>
              </g>
            );
          })}
          <Node at={anchorA} label="100.0" ink="var(--color-anchor)" sub="ORB · DEPTH 0" />
          <Node at={anchorB} label="100.0" ink="var(--color-anchor)" sub="ORB · DEPTH 0" />
          <Node at={member} label="60.0" ink="var(--color-seal)" sub="TIER 1 · DEPTH 1" />
          <text
            x={110}
            y={190}
            textAnchor="middle"
            fill="var(--color-cream)"
            style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500, fontVariantNumeric: "tabular-nums" }}
          >
            20 base + 20 + 20 = 60.0
          </text>
        </svg>
      </Panel>
    </div>
  );
}
