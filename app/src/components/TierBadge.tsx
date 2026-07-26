import { tierLabel } from "@/lib/format";
import type { Tier } from "@/lib/types";

const TIER_COLOR: Record<Tier, string> = {
  0: "var(--color-tier-0)",
  1: "var(--color-tier-1)",
  2: "var(--color-tier-2)",
};

/** Tier 0 reads as neutral taxonomy (outline); a tier with standing reads as live status (dot). */
export function TierBadge({ tier, className = "" }: { tier: Tier; className?: string }) {
  const color = TIER_COLOR[tier];
  return (
    <span className={`badge badge-outline ${className}`} style={{ color }}>
      {tier > 0 ? <span className="dot" /> : null}
      {tierLabel(tier)}
    </span>
  );
}
