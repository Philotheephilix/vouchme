import { anchorSourceLabel, fmtCountdown, fmtMultiplier, fmtScore, fmtSigned, tierLabel, truncateMiddle } from "@/lib/format";
import type { VouchContribution } from "@/lib/types";

/**
 * One endorsement as a self-contained horizontal tile: the endorser's disc on the left, their name
 * and the contribution on the top line, the derivation and expiry on the bottom line. A
 * zero-contribution vouch is dimmed and labelled (the anti-collusion rule shown, not hidden), never
 * dropped. Each tile is its own card — the callers render a `space-y` stack, not a shared list box.
 *
 * `max` is the largest counted contribution in the surrounding list; when given (profile density),
 * each counted tile draws a proportional rank tick along its base so the section reads as ranked
 * data, not a flat ledger.
 */
export function VouchRow({ row, compact = false, max }: { row: VouchContribution; compact?: boolean; max?: number }) {
  const name = row.voucher.ensName;
  // Truncated toward zero at one decimal, the same direction the engine truncates (invariant I-15),
  // so the printed product is the one the protocol would compute.
  const uncapped = Math.trunc(row.voucher.score * row.weight * 10) / 10;
  const capped = row.counted && uncapped > row.contribution + 0.05;
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const pad = compact ? "p-3" : "p-3.5";

  if (!row.counted) {
    return (
      <div
        data-testid="endorsement-zero"
        className={`card flex items-center gap-3 opacity-60 ${pad}`}
      >
        <Avatar initial={initial} tone="mute" compact={compact} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <div className="truncate-mono max-w-[190px] text-sm text-cream">{truncateMiddle(name, 24)}</div>
            <span className="shrink-0 font-mono text-sm text-graphite">{fmtSigned(row.contribution)}</span>
          </div>
          <div className="mt-0.5 font-mono text-2xs text-graphite">not counted · depth {row.voucher.depth ?? "∞"}</div>
        </div>
      </div>
    );
  }

  const accent = row.voucher.isAnchor ? "var(--color-anchor)" : "var(--color-seal)";
  // Proportional rank tick — relative to the strongest voucher in the list, so the ranking is legible
  // at a glance. Floors at 8% so a real contribution is never an empty sliver.
  const pct = max && max > 0 ? Math.max(8, Math.min(100, (row.contribution / max) * 100)) : 0;
  const showTick = !compact && pct > 0;

  return (
    <div
      data-testid="endorsement-row"
      className={`card relative flex items-center gap-3 overflow-hidden ${pad}`}
    >
      <Avatar initial={initial} tone={row.voucher.isAnchor ? "anchor" : "seal"} compact={compact} />

      <div className="min-w-0 flex-1">
        {/* top line — who, and the value they hand down */}
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate-mono max-w-[150px] text-sm font-medium text-cream">{truncateMiddle(name, 22)}</span>
            <span className="shrink-0 font-mono text-2xs text-graphite">
              {tierLabel(row.voucher.tier)} · d{row.voucher.depth}
            </span>
          </div>
          <span
            className={`shrink-0 inline-flex items-center font-mono font-semibold tabular-nums ${compact ? "text-sm" : "text-base"}`}
            style={{
              color: accent,
              background: `color-mix(in oklab, ${accent} 12%, transparent)`,
              borderRadius: 8,
              padding: compact ? "1px 7px" : "2px 9px",
              letterSpacing: "-0.01em",
            }}
          >
            {fmtSigned(row.contribution)}
          </span>
        </div>

        {/* bottom line — the math on the left (reaches the number above), the countdown on the right */}
        <div className="mt-1 flex items-baseline justify-between gap-3">
          <span className="truncate font-mono text-2xs text-graphite">
            {fmtScore(row.voucher.score)} × {fmtMultiplier(row.weight)} = {fmtScore(uncapped)}
            {capped ? ` → cap ${fmtScore(row.contribution)}` : ""}
          </span>
          <span
            className="shrink-0 font-mono text-2xs"
            style={{ color: row.expiringSoon ? "var(--color-protest)" : "var(--color-graphite)" }}
          >
            {row.expiringSoon ? "⚠ " : ""}
            {fmtCountdown(row.daysUntilExpiry)}
          </span>
        </div>

        {row.voucher.isAnchor ? (
          <span className="badge badge-outline mt-2 text-anchor">
            <span className="dot" />
            {anchorSourceLabel(row.voucher.anchorSource)}
          </span>
        ) : null}
      </div>

      {/* proportional rank tick pinned to the tile's base — ranking, shown horizontally */}
      {showTick ? (
        <span
          aria-hidden
          className="absolute bottom-0 left-0 h-[3px] rounded-full"
          style={{
            width: `${pct}%`,
            background: `linear-gradient(90deg, color-mix(in oklab, ${accent} 45%, #fff), ${accent})`,
          }}
        />
      ) : null}
    </div>
  );
}

/** Colour-carrying initial disc — a soft tonal gradient with a hairline ring and a low lift, so the
 *  endorser reads as a person, not a flat swatch. Tone follows the vouch: gold anchor, seal vouch. */
function Avatar({ initial, tone, compact }: { initial: string; tone: "seal" | "anchor" | "mute"; compact?: boolean }) {
  const s = compact ? 34 : 42;
  const c =
    tone === "anchor" ? "var(--color-anchor)" : tone === "seal" ? "var(--color-seal)" : "var(--color-graphite)";
  return (
    <div
      aria-hidden
      className="flex shrink-0 items-center justify-center font-bold"
      style={{
        width: s,
        height: s,
        borderRadius: compact ? 12 : 14,
        background: `linear-gradient(145deg, color-mix(in oklab, ${c} 24%, #fff), color-mix(in oklab, ${c} 9%, #fff))`,
        color: c,
        fontSize: compact ? 14 : 16,
        letterSpacing: "-0.02em",
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${c} 22%, transparent), 0 4px 12px -8px color-mix(in srgb, ${c} 80%, transparent)`,
      }}
    >
      {initial}
    </div>
  );
}
