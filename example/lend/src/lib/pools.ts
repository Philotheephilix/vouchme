import type { Standing } from "@vouchme/minikit-sdk";

/**
 * The pools, and the one function that decides who may draw from them.
 *
 * Shared by the page and by `/api/claim` on purpose: the page renders what this says, and the
 * route enforces what this says. One definition, so a pool can never look open and pay closed —
 * or worse, look closed and pay open.
 *
 * Tier 0 qualifies for nothing. That is not a gap in the product; it is the product. A score with
 * no consequence is a number, and a gate that lets everyone through is decoration.
 */

export type PoolId = "starter" | "standard" | "prime";

export type Requirement =
  | { kind: "tier"; tier: 1 | 2 }
  /** An Orb anchor. Deliberately NOT "tier 2": an anchor's score is administratively fixed at 100
   *  and ignores every inbound vouch, so it sits below the tier-2 score threshold and can never
   *  climb there. Gating Prime on tier alone would exclude the strongest credential in the system. */
  | { kind: "anchor" };

export interface Pool {
  id: PoolId;
  name: string;
  amountWld: string;
  requirement: Requirement;
}

export const POOLS: readonly Pool[] = [
  { id: "starter", name: "Starter", amountWld: "0.05", requirement: { kind: "tier", tier: 1 } },
  { id: "standard", name: "Standard", amountWld: "0.10", requirement: { kind: "tier", tier: 2 } },
  { id: "prime", name: "Prime", amountWld: "0.20", requirement: { kind: "anchor" } },
] as const;

export function findPool(id: unknown): Pool | null {
  return POOLS.find((pool) => pool.id === id) ?? null;
}

/** Six words at most — this is a chip on a card, not a paragraph. */
export function requirementLabel(requirement: Requirement): string {
  return requirement.kind === "anchor" ? "Orb anchor" : `Tier ${requirement.tier}`;
}

/**
 * The gate. `null` standing — no VouchMe account, or VouchMe unreachable — never qualifies.
 *
 * An anchor holds tier 2, so it clears the tier gates as well as its own.
 */
export function qualifies(pool: Pool, standing: Standing | null): boolean {
  if (!standing) return false;
  if (pool.requirement.kind === "anchor") return standing.kind === "anchor";
  return standing.tier >= pool.requirement.tier;
}
