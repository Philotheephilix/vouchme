/**
 * Fiar's lending policy. This file is Fiar's opinion, not VouchMe's.
 *
 * That separation is the whole point of the integration. VouchMe publishes one thing — how much a
 * person's standing is worth, and why. What that standing BUYS is a decision every integrator makes
 * for itself, in its own units, against its own risk. VouchMe has no idea Fiar exists and no say in
 * any number below.
 *
 * The two values Fiar cannot invent are the ends of VouchMe's scale, because they are VouchMe's:
 * they come from docs/10-constants.md and are restated here rather than derived, so moving them in
 * VouchMe without moving them here would make every ladder rung disagree with the real quote.
 */

/** docs/01-trust-math.md §11 — `base`, what enrolling alone is worth, and the Tier 2 threshold. */
export const ENROLLMENT_FLOOR = 20;
export const T2_SCORE = 140;

export const POLICY = {
  /** At full karma, the deposit falls by this much. Never to zero — Fiar takes a deposit from
   *  everybody, because a deposit of nothing is not a deposit, it is a gift. */
  depositMaxDiscount: 0.75,
  /** At full karma, the daily rate falls by this much. Deliberately gentler than the deposit
   *  discount: the deposit prices RISK, which reputation genuinely reduces, while the rate prices
   *  WEAR, which it does not. */
  rateMaxDiscount: 0.4,
  /** Extra off the deposit when borrower and owner are close in the vouch graph. This is the
   *  discount no other personhood system can offer, because a nullifier has no neighbours. */
  neighbourDepositDiscount: 0.1,
  /** How close counts as close, in vouch hops. */
  neighbourMaxHops: 2,
  /** Hard floors. Discounts stack, so without these a well-connected anchor would eventually
   *  borrow for free, and Fiar would be running an unsecured loan book by accident. */
  depositFloor: 0.15,
  rateFloor: 0.5,
  /** Value ceiling by tier, in USD: `base + step × tier`. Reputation does not only make borrowing
   *  cheaper, it makes more of the catalogue reachable — which is the part people act on. */
  ceilingBase: 150,
  ceilingPerTier: 250,
  /** A lapsed credential is not a report — it means nobody has checked recently. Fiar prices the
   *  uncertainty instead of refusing, by ignoring karma entirely for the duration. */
  gracePeriodKarmaMultiplier: 0.5,
} as const;

export interface Item {
  id: string;
  name: string;
  /** What Fiar would have to pay to replace it. The deposit is a fraction of this. */
  valueUsd: number;
  /** The undiscounted daily rate — what someone with no standing at all pays. */
  listRatePerDayUsd: number;
  owner: string;
  neighbourhood: string;
  /** Owner's own words. Shown verbatim; Fiar does not rewrite what people say about their things. */
  note: string;
}

export interface Quote {
  /** 0 at the enrollment floor, 1 at the Tier 2 threshold. Every discount is a function of this. */
  karmaFactor: number;
  depositUsd: number;
  ratePerDayUsd: number;
  /** What the same item costs somebody with no VouchMe standing at all. */
  depositAtFloorUsd: number;
  ratePerDayAtFloorUsd: number;
  depositSavedUsd: number;
  rateSavedPerDayUsd: number;
  /** Applied, and why. Present so the card can name the discount instead of just showing a number. */
  neighbourDiscountApplied: boolean;
  hopsToOwner: number | null;
  /** Highest item value this standing may borrow. */
  ceilingUsd: number;
  withinCeiling: boolean;
  /** True when the credential is in its 14-day grace window and karma was halved for it. */
  credentialDiscounted: boolean;
}

/**
 * The lowest tier whose ceiling reaches this item, or null if none does.
 *
 * Needed because "one more rung" is often a lie: a $520 camera is out of reach at Tier 0 AND at
 * Tier 1, so telling a Tier 0 borrower that the next rung raises their limit to $400 sends them to
 * earn a promotion that still would not get them the camera.
 */
export function tierThatReaches(valueUsd: number): 0 | 1 | 2 | null {
  for (const tier of [0, 1, 2] as const) {
    if (valueUsd <= POLICY.ceilingBase + POLICY.ceilingPerTier * tier) return tier;
  }
  return null;
}

export function ceilingFor(tier: 0 | 1 | 2): number {
  return POLICY.ceilingBase + POLICY.ceilingPerTier * tier;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * How far up VouchMe's scale this account has climbed: 0 at the enrollment floor, 1 at Tier 2.
 *
 * Measured against the ENROLLMENT floor for everyone, not against each account's own `base`.
 * Scaling from a personal floor looks more careful and is wrong: an Orb anchor's floor IS its score
 * (both 100), so `(score − base)` is zero for every anchor and the strongest credential in the
 * system would be quoted the full deposit.
 *
 * Anchors are then pinned to full karma rather than left at (100−20)/120 = 0.67, because an anchor's
 * score is administratively fixed and ignores every inbound vouch (FR-2) — it is structurally barred
 * from ever reaching 140, so pricing it on the distance to 140 penalises it for a ceiling VouchMe
 * imposed on it.
 */
export function karmaFactor(score: number, isAnchor: boolean): number {
  if (isAnchor) return 1;
  return clamp01((score - ENROLLMENT_FLOOR) / (T2_SCORE - ENROLLMENT_FLOOR));
}

export interface QuoteInput {
  item: Item;
  /** null when the borrower has no VouchMe account — the honest full-price case. */
  standing: {
    score: number;
    kind: "anchor" | "member" | "platform";
    tier: 0 | 1 | 2;
    credentialStatus: "active" | "grace" | "suspended";
  } | null;
  /** Vouch hops between borrower and owner, or null when they are not connected. */
  hopsToOwner: number | null;
}

export function quote({ item, standing, hopsToOwner }: QuoteInput): Quote {
  const tier = standing?.tier ?? 0;

  // A suspended credential means the 90-day check lapsed past its grace window (FR-6). The person
  // is not accused of anything, so Fiar does not refuse them — it just stops giving them credit for
  // a credential nobody has re-verified.
  const suspended = standing?.credentialStatus === "suspended";
  const inGrace = standing?.credentialStatus === "grace";
  const rawKarma = standing ? karmaFactor(standing.score, standing.kind === "anchor") : 0;
  const k = suspended ? 0 : inGrace ? rawKarma * POLICY.gracePeriodKarmaMultiplier : rawKarma;

  const neighbourDiscountApplied =
    hopsToOwner !== null && hopsToOwner > 0 && hopsToOwner <= POLICY.neighbourMaxHops;

  const depositRate = Math.max(
    POLICY.depositFloor,
    1 - POLICY.depositMaxDiscount * k - (neighbourDiscountApplied ? POLICY.neighbourDepositDiscount : 0),
  );
  const rateRate = Math.max(POLICY.rateFloor, 1 - POLICY.rateMaxDiscount * k);

  const depositUsd = roundCents(item.valueUsd * depositRate);
  const ratePerDayUsd = roundCents(item.listRatePerDayUsd * rateRate);
  const ceilingUsd = POLICY.ceilingBase + POLICY.ceilingPerTier * tier;

  return {
    karmaFactor: k,
    depositUsd,
    ratePerDayUsd,
    depositAtFloorUsd: roundCents(item.valueUsd),
    ratePerDayAtFloorUsd: roundCents(item.listRatePerDayUsd),
    depositSavedUsd: roundCents(item.valueUsd - depositUsd),
    rateSavedPerDayUsd: roundCents(item.listRatePerDayUsd - ratePerDayUsd),
    neighbourDiscountApplied,
    hopsToOwner,
    ceilingUsd,
    withinCeiling: item.valueUsd <= ceilingUsd,
    credentialDiscounted: inGrace,
  };
}

export interface LadderRung {
  tier: 0 | 1 | 2;
  label: string;
  /** The score this rung is quoted at. For the viewer's own row this is their real score, which is
   *  usually BETWEEN two thresholds — carol at 50 is a Tier 0 who is nowhere near the 20 the
   *  "Enrolled" row quotes. Marking a threshold row "you" instead of adding this one would print a
   *  score the viewer does not have. */
  score: number;
  depositUsd: number;
  ratePerDayUsd: number;
  ceilingUsd: number;
  withinCeiling: boolean;
}

/** docs/01-trust-math.md §11 — the Tier 1 promotion threshold. */
const T1_SCORE = 55;

/**
 * The same item priced at each rung of VouchMe's ladder, so a person can see what climbing buys
 * before they climb. Computed with the same `quote()` the real price uses — a separate display
 * formula here would be free to drift from what Fiar actually charges.
 */
export function ladder(item: Item): LadderRung[] {
  return [
    { tier: 0 as const, label: "Enrolled", score: ENROLLMENT_FLOOR },
    { tier: 1 as const, label: "Tier 1", score: T1_SCORE },
    { tier: 2 as const, label: "Tier 2", score: T2_SCORE },
  ].map(({ tier, label, score }) => rung(item, label, score, tier, "member"));
}

/**
 * The viewer's own row, quoted at their real score.
 *
 * Deliberately excludes the connection discount even though the real price includes it, so every
 * row in the table answers the same question — what does STANDING alone buy. The connection
 * discount is itemised on its own line above, where it can be attributed to the person who caused
 * it.
 */
export function youRung(item: Item, standing: QuoteInput["standing"]): LadderRung | null {
  if (!standing) return null;
  return rung(item, "You", standing.score, standing.tier, standing.kind);
}

function rung(
  item: Item,
  label: string,
  score: number,
  tier: 0 | 1 | 2,
  kind: "anchor" | "member" | "platform",
): LadderRung {
  const q = quote({ item, standing: { score, kind, tier, credentialStatus: "active" }, hopsToOwner: null });
  return {
    tier,
    label,
    score,
    depositUsd: q.depositUsd,
    ratePerDayUsd: q.ratePerDayUsd,
    ceilingUsd: q.ceilingUsd,
    withinCeiling: q.withinCeiling,
  };
}
