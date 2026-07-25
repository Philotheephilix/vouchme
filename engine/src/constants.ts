/**
 * Aval — engine constants, in centi-points (score × 100) unless noted otherwise.
 *
 * Single source of truth for these values is docs/10-constants.md; derivations live in
 * docs/01-trust-math.md and docs/16-presence-drip.md. Every numeric literal in this file cites
 * the doc section that defines it. Do not duplicate these numbers elsewhere in the engine —
 * import from here.
 */

// ── §1 Scoring (01-trust-math.md §4, §10; 10-constants.md §1) ──────────────────────────────────

/** Everyone's floor before tenure and vouches: 10.00 points. */
export const BASE = 1_000;

/** An anchor's score is fixed here and ignores all inbound edges (E-6): 100.00 points. */
export const ANCHOR = 10_000;

/** Cap on a single positive contribution (a vouch): 20.00 points. */
export const CAP_POS = 2_000;

/** Cap on a single negative contribution (a report): 40.00 points. */
export const CAP_NEG = 4_000;

/** Positive multiplier m⁺ = 0.25, expressed as an exact integer fraction. */
export const M_POS_NUM = 25;
export const M_POS_DEN = 100;

/** Negative multiplier m⁻ = 0.50 = 2 × m⁺ (01-trust-math.md §7.2), as an exact integer fraction. */
export const M_NEG_NUM = 50;
export const M_NEG_DEN = 100;

/** Voucher score at which the positive cap starts binding: cap⁺ / m⁺ = 80.00. */
export const CAP_POS_BINDING_THRESHOLD = 8_000;

/** Reporter score at which the negative cap starts binding: cap⁻ / m⁻ = 80.00. */
export const CAP_NEG_BINDING_THRESHOLD = 8_000;

// ── §2 Tiers (01-trust-math.md §11; 10-constants.md §2) ─────────────────────────────────────────

/** Tier 1 threshold: 30.00 points. Never lower this (01-trust-math.md §13). */
export const T1 = 3_000;

/** Tier 2 threshold: 100.00 points. */
export const T2 = 10_000;

/** Platform Tier 1 threshold: 40.00 points. */
export const P1 = 4_000;

/** Platform Tier 2 threshold: 150.00 points. */
export const P2 = 15_000;

// ── §3 Graph structure (01-trust-math.md §6; 10-constants.md §3) ────────────────────────────────

/** Maximum BFS depth from an origin; also the ENS label-count limit. */
export const MAX_DEPTH = 3;

/** Minimum distinct active inbound vouchers required to promote (gate 2). */
export const MIN_VOUCHERS = 2;

/** Outer origins-loop safety rail; converges in 2–3 rounds in practice. */
export const MAX_ROUNDS = 8;

// ── §7 Reports (01-trust-math.md §7; 10-constants.md §9) ────────────────────────────────────────

/** Only the top-K highest-weighted valid reports count against any one target. */
export const TOP_K = 3;

/** Reports decay linearly to zero over this many days after being upheld. */
export const REPORT_DECAY_DAYS = 180;

/** Gate 4 (Tier 2 only): no upheld report against the account within this window. */
export const GATE4_WINDOW_DAYS = 90;

// ── §14 Decay / expiry (01-trust-math.md §14; 10-constants.md §5, §10) ──────────────────────────

/** A vouch's contribution drops to zero this many days after issue / last re-affirm. */
export const VOUCH_EXPIRY_DAYS = 90;

/** Credential validity window before the account enters the grace period. */
export const CREDENTIAL_VALIDITY_DAYS = 90;

/** Grace period after credential expiry before an account is treated as suspended. */
export const CREDENTIAL_GRACE_DAYS = 14;

/** Platform vouches expire slower than human vouches — platforms are stabler than people. */
export const PLATFORM_VOUCH_EXPIRY_DAYS = 180;

/** Fraud slot penalty duration. */
export const FRAUD_SLOT_PENALTY_DAYS = 30;

// ── §4 Slots and rate limits (10-constants.md §4, §10) ───────────────────────────────────────────

export const SLOTS_TIER_0 = 0;
export const SLOTS_TIER_1 = 3;
export const SLOTS_TIER_2 = 10;

export const PLATFORM_SLOTS_TIER_1_HUMAN = 5;
export const PLATFORM_SLOTS_TIER_2_HUMAN = 20;

/** New-vouch rate limit, in hours between new vouches from the same account. */
export const NEW_VOUCH_RATE_LIMIT_HOURS = 24;

/** New platform-vouch rate limit: 3 per 24h (10-constants.md §10). */
export const NEW_PLATFORM_VOUCH_RATE_LIMIT_PER_DAY = 3;

// ── §12 Presence drip and tenure (16-presence-drip.md §2, §4, §6) ───────────────────────────────

/** Length of one presence-drip epoch, in seconds: 6 hours. */
export const SECONDS_PER_EPOCH = 6 * 60 * 60;

/** Seconds in a day, used for day-denominated decay/expiry windows. */
export const SECONDS_PER_DAY = 24 * 60 * 60;

/** Unclaimed accrual stops growing past this many epochs (30 days) — the presence requirement. */
export const MAX_UNCLAIMED_EPOCHS = 120;

/** Tenure half-life, in epochs: 720 epochs = 180 days. */
export const E_HALF = 720;

/** Hard ceiling on the tenure bonus, in centi-points: 5.00 points, never reached in continuous
 *  math but saturated exactly by the deterministic integer band formula (see tenure.ts). */
export const T_MAX_CENTI = 500;

/** Tier-0 presence-drip rate, as a percentage of the nominal rate. */
export const TIER_0_DRIP_RATE_PERCENT = 25;

/** Tier-1 / Tier-2 presence-drip rate, as a percentage of the nominal rate. */
export const TIER_1_PLUS_DRIP_RATE_PERCENT = 100;
