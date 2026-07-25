/**
 * Aval — tenure curve (docs/16-presence-drip.md §4).
 *
 * Continuous ideal:
 *
 *   tenure(E) = T_MAX × (1 − 2^(−E / E_HALF))
 *
 * CORRECTED deterministic integer implementation. The formula as first printed in
 * docs/16-presence-drip.md §4 ("halving bands with linear interpolation") reads:
 *
 *   lo = 500 - (500 >> k)
 *   hi = 500 - (500 >> (k + 1))
 *   tenure_centi = lo + (hi - lo) * r / E_HALF
 *
 * That truncates `500 / 2^k` *before* the subtraction, which pushes `lo` up by one centi-point
 * whenever the division is inexact (k=3: `500 >> 3` = 62, giving lo = 438; the doc's own worked
 * table says 437). The doc's printed TABLE is authoritative, not that pseudocode. The fix is to
 * truncate once, after combining everything into a single rational — `lo = 500(2^k−1)/2^k`
 * exactly, and `hi − lo` simplifies to `500 / 2^(k+1)`:
 *
 *   num = 500 × (2^k − 1) × 2 × E_HALF  +  500 × r
 *   den = 2^(k+1) × E_HALF
 *   tenure_centi = floor(num / den)                       // the only truncation
 *
 * Saturation: the curve's true value approaches T_MAX_CENTI but never reaches it for any finite
 * E, so without a clamp this would return 499 forever, and invariant I-17 ("1,000,000 claimed
 * epochs + zero vouches ⇒ score exactly 1500 centi, Tier 0") would fail at 1499. At k = 16 half-
 * lives (≈ 7.9 years) the true value is 499.992 — clamping to T_MAX_CENTI there is a deliberate,
 * documented saturation point, not a fudge, and it keeps `1 << k` from ever being evaluated for
 * large k.
 *
 * All arithmetic here is integer; num/den fit comfortably inside a JS safe integer for every
 * representable k < 16.
 */

import { E_HALF, T_MAX_CENTI } from "./constants.js";

/** Band index at which the curve is treated as fully saturated at T_MAX_CENTI (≈ 7.9 years). */
const SATURATION_K = 16;

/**
 * Tenure bonus for `epochsClaimed` claimed presence-drip epochs, in centi-points, per the
 * corrected halving-band formula above. Pure, deterministic, integer-only.
 */
export function tenureCenti(epochsClaimed: number): number {
  if (!Number.isFinite(epochsClaimed) || !Number.isInteger(epochsClaimed) || epochsClaimed < 0) {
    throw new RangeError(
      `tenureCenti: epochsClaimed must be a non-negative integer, got ${epochsClaimed}`,
    );
  }
  const E = epochsClaimed;
  if (E <= 0) return 0;

  const k = Math.floor(E / E_HALF);
  if (k >= SATURATION_K) return T_MAX_CENTI;

  const r = E % E_HALF;
  const num = T_MAX_CENTI * ((1 << k) - 1) * 2 * E_HALF + T_MAX_CENTI * r;
  const den = (1 << (k + 1)) * E_HALF;
  return Math.floor(num / den);
}
