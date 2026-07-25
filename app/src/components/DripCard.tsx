import { fmtAval, fmtDays, fmtScore } from "@/lib/format";
import type { PresenceState } from "@/lib/types";

/**
 * A ledger stub, not a widget: the daily rate, the accrued figure, a hairline 30-day countdown
 * with a tick, and the tenure curve flattening toward a dashed ceiling. The flattening is the
 * point — docs/16-presence-drip.md §4.1: presence alone can never promote anyone.
 */
export function DripCard({ presence }: { presence: PresenceState }) {
  const claimedFraction = Math.min(1, Math.max(0, (presence.maxUnclaimedDays - presence.daysUntilCap) / presence.maxUnclaimedDays));
  const claimedPct = claimedFraction * 100;

  return (
    <div data-testid="drip-card" className="border border-rule p-4">
      <div className="flex items-baseline justify-between">
        <span className="text-2xs uppercase tracking-widest text-graphite">Presence drip</span>
        <span className="font-mono text-2xs text-graphite">{presence.tierRatePct}% rate</span>
      </div>

      <div className="mt-3 flex items-end justify-between gap-4">
        <div>
          <div className="font-mono text-base text-cream">
            {fmtAval(presence.dailyRateAval)}
            <span className="text-graphite">/day</span>
          </div>
          <div className="font-serif text-cream" style={{ fontSize: "var(--text-2xl)", lineHeight: 1.1 }}>
            {presence.accruedAval.toFixed(1)}
          </div>
          <div className="text-2xs text-graphite">accrued, unclaimed</div>
        </div>
        <button
          type="button"
          className="min-h-[44px] shrink-0 border px-4 font-mono text-xs uppercase tracking-widest"
          style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
        >
          Claim
        </button>
      </div>

      <div className="mt-5">
        <div className="mb-1 flex justify-between font-mono text-2xs text-graphite">
          <span>0d</span>
          <span>{fmtDays(presence.daysUntilCap)} until cap</span>
          <span>{presence.maxUnclaimedDays}d</span>
        </div>
        <div className="relative h-px w-full" style={{ backgroundColor: "var(--color-rule)" }}>
          <div
            className="absolute left-0 top-0 h-px"
            style={{ width: `${claimedPct}%`, backgroundColor: "var(--color-seal)" }}
          />
          <div
            className="absolute top-1/2 h-2 w-px -translate-y-1/2"
            style={{ left: `${claimedPct}%`, backgroundColor: "var(--color-cream)" }}
          />
        </div>
      </div>

      <div className="mt-6">
        <div className="mb-1 flex items-baseline justify-between">
          <span className="text-2xs text-graphite">Present {presence.presentDays}d</span>
          <span className="font-mono text-sm" style={{ color: "var(--color-seal)" }}>
            tenure +{fmtScore(presence.tenureBonus)}
          </span>
        </div>
        <TenureCurve presence={presence} />
        <div className="mt-1 text-right font-mono text-2xs text-graphite">MAX +{presence.tenureMaxBonus.toFixed(2)}</div>
      </div>
    </div>
  );
}

function TenureCurve({ presence }: { presence: PresenceState }) {
  const width = 280;
  const height = 56;
  const top = 5;
  const bottom = height - 4;
  const maxDays = presence.curve.length > 0 ? presence.curve[presence.curve.length - 1]!.days : 1;
  const maxTenure = Math.max(presence.tenureMaxBonus, ...presence.curve.map((p) => p.tenure));

  const points = presence.curve
    .map((p) => {
      const x = maxDays > 0 ? (p.days / maxDays) * width : 0;
      const y = bottom - (p.tenure / maxTenure) * (bottom - top);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const currentX = maxDays > 0 ? (presence.presentDays / maxDays) * width : 0;
  const currentY = bottom - (presence.tenureBonus / maxTenure) * (bottom - top);

  return (
    <svg
      data-testid="tenure-curve"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Tenure bonus ${presence.tenureBonus.toFixed(2)} of a maximum ${presence.tenureMaxBonus.toFixed(2)}`}
    >
      <line x1={0} y1={top} x2={width} y2={top} stroke="var(--color-rule)" strokeWidth={1} strokeDasharray="3 3" />
      <polyline points={points} fill="none" stroke="var(--color-seal)" strokeWidth={1} />
      <circle cx={currentX} cy={currentY} r={2.5} fill="var(--color-cream)" />
    </svg>
  );
}
