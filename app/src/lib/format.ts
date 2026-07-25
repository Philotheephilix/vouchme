/**
 * Display formatting + the presence-drip tenure curve (docs/16-presence-drip.md §4).
 *
 * All protocol arithmetic is integer centi-points (docs/01-trust-math.md §10, invariant I-15):
 * truncation toward zero, applied once per contribution, before summation. These helpers convert
 * between that integer domain and the one-decimal display domain the UI renders — the conversion
 * itself never introduces new rounding beyond the spec's own truncation.
 */

import { tenureCenti } from "@aval/engine";
import type { AnchorSource, ScoreResult, Tier, PlatformTier } from "./types";

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
 * (see app/layout.tsx), so any glyph must be checked against that subset first. U+23F3 (HOURGLASS)
 * has default *emoji* presentation — browsers route it to a colour-emoji font that isn't guaranteed
 * to be installed, and it falls back to tofu. The colour + `expiringSoon` triangle (⚠, default
 * *text* presentation, covered by ordinary fallback fonts) already carry the urgency signal.
 */
export function fmtCountdown(days: number): string {
  return fmtDays(days);
}

export function tierLabel(tier: Tier): string {
  return `TIER ${tier}`;
}

export interface ScoreTerm {
  label: string;
  value: number;
}

/**
 * The named terms behind a score, and whether they actually add up to it.
 *
 * This exists as one function, rather than a line of JSX at each call site, so the printed equation
 * is always assembled from the full set of terms and checked against the score above it.
 * `matchesScore` is that check: a caller that gets `false` must not print the equation, because an
 * equation that doesn't equal the score is worse than no equation at all.
 *
 * Anchors are deliberately not expressible here — their score is fixed at `ANCHOR` and ignores
 * every inbound edge, so there is no sum to show. Callers branch on `kind` first.
 */
export function scoreTerms(r: ScoreResult): { terms: ScoreTerm[]; total: number; matchesScore: boolean } {
  const terms: ScoreTerm[] = [{ label: "base", value: r.base }];
  if (r.tenure > 0) terms.push({ label: "presence", value: r.tenure });
  const vouches = r.breakdown.filter((b) => b.counted).reduce((sum, b) => sum + b.contribution, 0);
  if (vouches > 0) terms.push({ label: "vouches", value: vouches });
  const total = terms.reduce((sum, t) => sum + t.value, 0);
  // One-decimal display, so agreement is judged at the precision actually printed.
  return { terms, total, matchesScore: Math.abs(total - r.score) < 0.05 };
}

/**
 * The ONLY place "anchor: …" text is composed. Anchors here are genesis-testnet, not Orb
 * (contracts/script/GenesisAnchorBook.sol) — presenting one as the other would forge the single
 * externally-grounded fact the protocol depends on, so every anchor label routes through this
 * function rather than being typed inline at each call site.
 */
export function anchorSourceLabel(source: AnchorSource | undefined): string {
  if (source === "genesis-testnet") return "anchor: genesis (testnet)";
  // World Chain mainnet, backed by World ID's real Address Book — the only value here that
  // represents an actual Orb-verified human.
  if (source === "world-id-orb") return "anchor: world id orb";
  if (source === "orb") return "anchor: orb";
  return "anchor: unverified provenance";
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
 * `tenureCenti` is imported directly from `@aval/engine` rather than reimplemented here: invariant
 * I-19 requires the app and the engine to agree exactly, and a hand-rolled port of the halving-band
 * formula drifts by a centi-point at band boundaries. One implementation, no copy to keep in sync.
 */
const EPOCHS_PER_DAY = 4; // 6h epochs

export function tenureFromDays(presentDays: number): number {
  return centiToScore(tenureCenti(Math.floor(presentDays * EPOCHS_PER_DAY)));
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
