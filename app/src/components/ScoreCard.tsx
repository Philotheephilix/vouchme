"use client";

import { useRef, useState } from "react";
import { dropVouchMeSuffix, fmtScore, tierLabel } from "@/lib/format";
import type { Tier } from "@/lib/types";

interface ScoreCardProps {
  /** ENS name, e.g. `asha.vouchme.eth` — printed as the cardholder line. */
  name: string;
  /** 0x address — its last four characters become the card's visible digits. */
  address: string;
  score: number;
  tier: Tier;
  /** distance to an anchor, or null when there is no path to one yet */
  depth: number | null;
  /** Orb-verified origin — the card turns gold, the way an anchor is gold everywhere. */
  isAnchor?: boolean;
  /** pointer-tilt + sheen; leave on for the hero, off for dense lists */
  interactive?: boolean;
}

/**
 * The score, worn like a card. VouchMe has no money on its face — the hero figure is the trust
 * *score*, so this is the wallet design's credit-card object with the balance re-cast as standing:
 * cardholder = ENS handle, the four digits = the address tail, "available balance" = the score,
 * the expiry line = tier + depth. Anchors read gold; everyone else rides the indigo-lit carbon.
 */
export function ScoreCard({ name, address, score, tier, depth, isAnchor = false, interactive = true }: ScoreCardProps) {
  const [tf, setTf] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  const onMove = (e: React.PointerEvent) => {
    if (!interactive || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    setTf(`rotateX(${(-py * 9).toFixed(2)}deg) rotateY(${(px * 12).toFixed(2)}deg)`);
  };
  const onLeave = () => setTf("");

  const [whole, frac = "0"] = fmtScore(score).split(".");
  const digits = address.replace(/^0x/i, "").slice(-4).toUpperCase();
  const cardholder = dropVouchMeSuffix(name).toUpperCase();
  const face = isAnchor ? "linear-gradient(150deg,#2a2410,#131108)" : "#111318";
  const glow = isAnchor
    ? "radial-gradient(115% 105% at 100% 0%,rgba(201,162,39,.5),transparent 60%)"
    : "radial-gradient(115% 105% at 100% 0%,color-mix(in oklab, var(--color-accent) 46%, transparent),transparent 60%)";
  const puddle = isAnchor
    ? "rgba(201,162,39,.16)"
    : "color-mix(in oklab, var(--color-accent) 16%, transparent)";
  const meta = depth === null ? "NO ANCHOR PATH" : `${tierLabel(tier)} · DEPTH ${depth}`;

  return (
    <div data-testid="score-card" style={{ perspective: 900 }}>
      <div
        ref={ref}
        onPointerMove={onMove}
        onPointerLeave={onLeave}
        className="anim-pop-bounce"
        style={{
          position: "relative",
          height: 214,
          borderRadius: "var(--radius-xl)",
          overflow: "hidden",
          background: face,
          transform: tf,
          transformStyle: "preserve-3d",
          transition: "transform .5s cubic-bezier(.16,1,.3,1)",
          boxShadow: "0 28px 46px -30px rgba(17,19,24,.62)",
        }}
      >
        <div style={{ position: "absolute", inset: 0, background: glow }} />
        <div
          style={{
            position: "absolute",
            left: -52,
            bottom: -88,
            width: 210,
            height: 210,
            borderRadius: "50%",
            background: puddle,
          }}
        />
        {interactive ? (
          <div
            aria-hidden
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              width: "30%",
              height: "100%",
              background: "linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.08),rgba(255,255,255,0))",
              animation: "sheen 5.2s cubic-bezier(.4,0,.2,1) 1s infinite",
            }}
          />
        ) : null}

        <div
          style={{
            position: "absolute",
            inset: 0,
            padding: "22px 24px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
            <div
              className="truncate-mono"
              style={{
                fontFamily: "var(--font-sans)",
                fontSize: 12,
                fontWeight: 600,
                letterSpacing: ".22em",
                color: "rgba(255,255,255,.88)",
                minWidth: 0,
              }}
            >
              {cardholder}
            </div>
            {/* the chip — gold, the anchor's colour, so the one scarce signal reads instantly */}
            <div
              style={{
                width: 38,
                height: 27,
                borderRadius: 5,
                background: isAnchor
                  ? "linear-gradient(150deg,#f4e2a8,#d4a935)"
                  : "linear-gradient(150deg,#ecd8a8,#c8a566)",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 3,
                padding: "0 6px",
                flex: "none",
              }}
            >
              <div style={{ height: 1, background: "rgba(96,72,20,.45)" }} />
              <div style={{ height: 1, background: "rgba(96,72,20,.45)" }} />
              <div style={{ height: 1, background: "rgba(96,72,20,.45)" }} />
            </div>
          </div>

          <div
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              letterSpacing: ".16em",
              color: "rgba(255,255,255,.42)",
            }}
          >
            •••• •••• •••• {digits}
          </div>

          <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
            <div>
              <div
                style={{
                  fontSize: 9.5,
                  letterSpacing: ".16em",
                  textTransform: "uppercase",
                  color: "rgba(255,255,255,.45)",
                  fontWeight: 600,
                }}
              >
                {isAnchor ? "Anchor · score fixed" : "Trust score"}
              </div>
              <div
                data-testid="score-card-figure"
                style={{ display: "flex", alignItems: "baseline", marginTop: 5, color: "#fff" }}
              >
                <span style={{ fontSize: 31, fontWeight: 700, letterSpacing: "-.035em", fontVariantNumeric: "tabular-nums" }}>
                  {whole}
                </span>
                <span
                  className="font-mono"
                  style={{ fontSize: 15, color: "rgba(255,255,255,.5)", marginLeft: 1 }}
                >
                  .{frac}
                </span>
              </div>
            </div>
            <div
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: 10,
                letterSpacing: ".08em",
                color: isAnchor ? "rgba(244,226,168,.72)" : "rgba(255,255,255,.45)",
                paddingBottom: 5,
                whiteSpace: "nowrap",
                flex: "none",
              }}
            >
              {meta}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
