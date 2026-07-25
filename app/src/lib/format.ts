/**
 * Display formatting + the presence-drip tenure curve (docs/16-presence-drip.md §4).
 *
 * All protocol arithmetic is integer centi-points (docs/01-trust-math.md §10, invariant I-15):
 * truncation toward zero, applied once per contribution, before summation. These helpers convert
 * between that integer domain and the one-decimal display domain the UI renders — the conversion
 * itself never introduces new rounding beyond the spec's own truncation.
 */

import type { Tier, PlatformTier } from "./types";

const CENTI = 100;

/** Integer centi-points (as emitted by the engine / on-chain) -> display score. */
export function centiToScore(centi: number): number {
  return centi / CENTI;
}

export function scoreToCenti(score: number): number {
  return Math.round(score * CENTI);
}

/** Fixed one-decimal display: 35 -> "35.0", 12.5 -> "12.5". */
export function fmtScore(score: number): string {
  return score.toFixed(1);
}

export function fmtCentiScore(centi: number): string {
  return fmtScore(centiToScore(centi));
}

/** Signed one-decimal display for contribution rows: 12.5 -> "+12.5", 0 -> "+0.0". */
export function fmtSigned(score: number): string {
  const sign = score < 0 ? "-" : "+";
  return `${sign}${Math.abs(score).toFixed(1)}`;
}

/** Multiplier display: 0.25 -> "0.25". */
export function fmtMultiplier(weight: number): string {
  return weight.toFixed(2);
}

export function fmtPct(pct: number): string {
  return `${pct.toFixed(0)}%`;
}

export function fmtAval(amount: number): string {
  return `${amount.toFixed(2)} AVAL`;
}

export function fmtDays(days: number): string {
  return `${Math.round(days)}d`;
}

export function fmtHours(hours: number): string {
  return `${Math.round(hours)}h`;
}

/**
 * "74d" style countdown used next to inbound vouches.
 *
 * Deliberately no icon glyph here: the fonts in this app are loaded with only the `latin` subset
 * (see app/layout.tsx), so a character has to be checked against that subset before it's used, not
 * assumed safe because it "looks like text". U+23F3 (HOURGLASS) has default *emoji* presentation —
 * browsers route it to a colour-emoji font, which isn't guaranteed to be installed, and it rendered
 * as a tofu box in exactly that situation. The colour + `expiringSoon` triangle (⚠, default *text*
 * presentation, covered by ordinary fallback fonts) already carry the urgency signal.
 */
export function fmtCountdown(days: number): string {
  return fmtDays(days);
}

export function tierLabel(tier: Tier): string {
  return `TIER ${tier}`;
}

export function platformTierLabel(tier: PlatformTier): string {
  return tier;
}

export function daysUntil(iso: string, now: Date = new Date()): number {
  const diffMs = new Date(iso).getTime() - now.getTime();
  return diffMs / (1000 * 60 * 60 * 24);
}

export function hoursUntil(iso: string, now: Date = new Date()): number {
  const diffMs = new Date(iso).getTime() - now.getTime();
  return diffMs / (1000 * 60 * 60);
}

export function fmtDate(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/**
 * Middle-out truncation for long ENS names / addresses — never wrap, never overflow, and never
 * eat the part the user actually needs (the tail is usually where a name diverges: "carol.ali…" is
 * indistinguishable from every other name that starts with "carol.ali", but "carol…aval.eth" is
 * not). Splits the visible `max` characters (plus the ellipsis) between the head and tail.
 */
export function truncateMiddle(name: string, max = 18): string {
  if (name.length <= max) return name;
  const headLen = Math.ceil((max - 1) / 2);
  const tailLen = Math.floor((max - 1) / 2);
  return `${name.slice(0, headLen)}…${name.slice(name.length - tailLen)}`;
}

/**
 * Drops the shared `.aval.eth` registrar suffix for compact side-by-side display (docs/04-ens.md
 * §1.2 members register under it; the collusion-ring fixture's flat `*.eth` ids are left
 * untouched, since they don't share it). Used where every name in a list is already known to
 * share the suffix, so re-printing it on every row is pure noise — see /explore's edge list.
 */
export function dropAvalSuffix(name: string): string {
  const suffix = ".aval.eth";
  return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

/**
 * Presence-drip tenure curve — docs/16-presence-drip.md §4.
 *
 *   E        = epochs claimed (6h each), monotone
 *   E_HALF   = 720 epochs = 180 days
 *   T_MAX    = 5.00 points
 *   tenure(E) = T_MAX * (1 - 2^(-E / E_HALF))
 *
 * Deterministic integer halving-band implementation (as specified, §4):
 *   k  = E / E_HALF                 // band index
 *   r  = E % E_HALF                 // position within the band
 *   lo = 500 - (500 >> k)           // centi-points
 *   hi = 500 - (500 >> (k + 1))
 *   tenure_centi = lo + (hi - lo) * r / E_HALF
 *
 * Invariant I-17: base + T_MAX = 15 < T1 = 30 — presence alone can never promote anyone.
 */
const E_HALF_EPOCHS = 720;
const T_MAX_CENTI = 500;
const EPOCHS_PER_DAY = 4; // 6h epochs

export function tenureCentiFromEpochs(epochsClaimed: number): number {
  if (epochsClaimed <= 0) return 0;
  const k = Math.floor(epochsClaimed / E_HALF_EPOCHS);
  // 2^-k underflows to 0 in this integer scheme well before k gets here; saturate explicitly
  // rather than lean on `>>`'s 32-bit wraparound for pathologically large epoch counts.
  if (k >= 32) return T_MAX_CENTI;
  const r = epochsClaimed % E_HALF_EPOCHS;
  const lo = T_MAX_CENTI - (T_MAX_CENTI >> k);
  const hi = T_MAX_CENTI - (T_MAX_CENTI >> (k + 1));
  return lo + Math.floor(((hi - lo) * r) / E_HALF_EPOCHS);
}

export function tenureFromDays(presentDays: number): number {
  return centiToScore(tenureCentiFromEpochs(Math.floor(presentDays * EPOCHS_PER_DAY)));
}

export function daysFromEpochs(epochs: number): number {
  return epochs / EPOCHS_PER_DAY;
}

/** Sampled points for the tenure curve chart, flattening toward the T_MAX dashed ceiling. */
export function tenureCurve(maxDays: number, steps: number): Array<{ days: number; tenure: number }> {
  const points: Array<{ days: number; tenure: number }> = [];
  for (let i = 0; i <= steps; i++) {
    const days = (maxDays * i) / steps;
    points.push({ days, tenure: tenureFromDays(days) });
  }
  return points;
}
