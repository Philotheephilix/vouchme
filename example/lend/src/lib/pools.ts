import type { Standing } from "@vouchme/minikit-sdk";
import { MINIMUM_AGE, type IdentityPolicy } from "./identity";

/**
 * The pools, and the one function that decides who may draw from them.
 *
 * Shared by the page and by `/api/claim` on purpose: the page renders what this says, and the
 * route enforces what this says. One definition, so a pool can never look open and pay closed —
 * or worse, look closed and pay open.
 *
 * Tier 0 qualifies for nothing. That is not a gap in the product; it is the product. A score with
 * no consequence is a number, and a gate that lets everyone through is decoration.
 *
 * Every pool carries TWO requirements, and they are different kinds of thing:
 *
 *   `requirement`  standing — how much do we trust you. Earned, revocable, continuous.
 *   `identity`     eligibility — may we legally serve you. Statutory, binary, unbuyable.
 *
 * `qualifies()` below answers only the first. The second lives in `identity.ts` and is evaluated
 * separately, because a gate you can climb with a high enough score is not a legal control. See
 * that file's doc comment for why the separation is load-bearing rather than tidy.
 */

export type PoolId = "starter" | "standard" | "prime";

export type Requirement =
  | { kind: "tier"; tier: 1 | 2 }
  /** A raw score floor, which is how the top pool asks for standing that was EARNED rather than
   *  granted.
   *
   *  An Orb anchor's score is administratively fixed at 100 and ignores every inbound vouch, so a
   *  floor above 100 is one an anchor can never climb to no matter how long it holds the strongest
   *  credential in the system — while a Tier 2 member who has actually been vouched for passes it.
   *  That is the intent: Prime rewards accumulated trust, not a credential. It is also why the top
   *  pool is not gated on the anchor credential, which every anchor would clear on day one. */
  | { kind: "score"; minScore: number };

export interface Pool {
  id: PoolId;
  name: string;
  amountWld: string;
  /** Standing. What VouchMe says about this person's trustworthiness. */
  requirement: Requirement;
  /** Eligibility. What the law says about serving this person. Orthogonal to the above; both pass
   *  or nothing is paid. */
  identity: IdentityPolicy;
}

/**
 * Every pool pays real WLD, so every pool carries the age floor — there is no tier of this product
 * that may be offered to a minor.
 *
 * Jurisdiction is what separates them. Starter is the smallest draw and is offered wherever Lend
 * operates, so it asks ONE attribute. Standard and Prime are larger and territorially licensed, so
 * they ask two. That asymmetry is the point: the request is sized to the decision, and a person
 * taking the smallest loan is never asked where their document came from.
 */
export const POOLS: readonly Pool[] = [
  {
    id: "starter",
    name: "Starter",
    amountWld: "0.05",
    requirement: { kind: "tier", tier: 1 },
    identity: { minimumAge: MINIMUM_AGE, jurisdiction: "any" },
  },
  {
    id: "standard",
    name: "Standard",
    amountWld: "0.10",
    requirement: { kind: "tier", tier: 2 },
    identity: { minimumAge: MINIMUM_AGE, jurisdiction: "served" },
  },
  {
    id: "prime",
    name: "Prime",
    amountWld: "0.20",
    requirement: { kind: "score", minScore: 105 },
    identity: { minimumAge: MINIMUM_AGE, jurisdiction: "served" },
  },
] as const;

export function findPool(id: unknown): Pool | null {
  return POOLS.find((pool) => pool.id === id) ?? null;
}

/** Six words at most — this is a chip on a card, not a paragraph. */
export function requirementLabel(requirement: Requirement): string {
  return requirement.kind === "score" ? `Score ${requirement.minScore}+` : `Tier ${requirement.tier}`;
}

/**
 * The STANDING gate, and only the standing gate. Passing this does not mean a claim is allowed; it
 * means the trust half is satisfied. `/api/claim` must also clear the identity half.
 *
 * `null` standing — no VouchMe account, or VouchMe unreachable — never qualifies.
 *
 * An anchor holds tier 2, so it clears both tier gates. It does NOT clear the score floor, which is
 * the whole point of expressing the top pool that way: three pools that one credential opens at
 * once are not a ladder.
 */
export function qualifies(pool: Pool, standing: Standing | null): boolean {
  if (!standing) return false;
  if (pool.requirement.kind === "score") return standing.score >= pool.requirement.minScore;
  return standing.tier >= pool.requirement.tier;
}
