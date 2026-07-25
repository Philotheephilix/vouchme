import { tierLabel } from "@/lib/format";
import type { Tier } from "@/lib/types";

const TIER_COLOR: Record<Tier, string> = {
  0: "var(--color-tier-0)",
  1: "var(--color-tier-1)",
  2: "var(--color-tier-2)",
};

export function TierBadge({ tier, className = "" }: { tier: Tier; className?: string }) {
  const color = TIER_COLOR[tier];
  return (
    <span
      className={`inline-block whitespace-nowrap border px-1.5 py-0.5 font-mono text-2xs uppercase tracking-widest ${className}`}
      style={{ color, borderColor: color }}
    >
      {tierLabel(tier)}
    </span>
  );
}
