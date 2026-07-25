import { fmtCountdown, fmtMultiplier, fmtScore, fmtSigned, tierLabel } from "@/lib/format";
import type { VouchContribution } from "@/lib/types";

/**
 * One endorsement on the back of the note: the endorser's own standing on the left, the
 * contribution they hand down on the right, the derivation underneath. A zero-contribution vouch
 * is overprinted rather than hidden — the anti-collusion rule shown, not explained.
 */
export function VouchRow({ row }: { row: VouchContribution }) {
  const name = row.voucher.ensName;

  if (!row.counted) {
    return (
      <div data-testid="endorsement-zero" className="relative overflow-hidden border-b border-rule py-3 opacity-40">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="truncate-mono max-w-[210px] text-sm text-cream">{name}</div>
            <div className="mt-0.5 font-mono text-2xs text-graphite">depth {row.voucher.depth ?? "∞"}</div>
          </div>
          <div className="shrink-0 font-mono text-base text-graphite">{fmtSigned(row.contribution)}</div>
        </div>
        <div className="mt-1 flex justify-center">
          <span
            aria-hidden="true"
            className="max-w-full select-none overflow-hidden text-ellipsis whitespace-nowrap font-mono text-2xs uppercase tracking-wide"
            style={{ color: "var(--color-protest)", transform: "rotate(-6deg)" }}
          >
            not negotiable — depth {row.voucher.depth ?? "∞"}
          </span>
        </div>
        <p className="mt-1 max-w-[80%] text-2xs leading-relaxed text-graphite">{row.reason}</p>
      </div>
    );
  }

  return (
    <div data-testid="endorsement-row" className="border-b border-rule py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate-mono max-w-[210px] text-sm text-cream">{name}</div>
          <div className="mt-0.5 font-mono text-2xs text-graphite">
            {tierLabel(row.voucher.tier)} · depth {row.voucher.depth}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="font-mono text-base" style={{ color: "var(--color-seal)" }}>
            {fmtSigned(row.contribution)}
          </div>
          <div
            className="font-mono text-2xs"
            style={{ color: row.expiringSoon ? "var(--color-protest)" : "var(--color-graphite)" }}
          >
            {row.expiringSoon ? "⚠ " : ""}
            {fmtCountdown(row.daysUntilExpiry)}
          </div>
        </div>
      </div>
      <div className="mt-1.5 font-mono text-2xs text-graphite">
        {fmtScore(row.voucher.score)} x {fmtMultiplier(row.weight)}
      </div>
    </div>
  );
}
