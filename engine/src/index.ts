/**
 * @vouchme/engine — the VouchMe trust-mathematics scoring engine.
 *
 * A pure, dependency-free function `(edges, anchors, now) -> scores`, implementing
 * docs/01-trust-math.md end to end. No I/O, no wall-clock reads, no randomness, no floats in the
 * scoring path. See `compute()` in `score.ts` for the five-stage algorithm.
 */

export * from "./constants.js";
export * from "./types.js";
export { tenureCenti } from "./tenure.js";
// `weightNeg` is exported so a consumer needing "how much damage can this account's report do"
// imports the real formula (min(s × m⁻, cap⁻), truncated) rather than re-implementing it from the
// constants. `app/src/app/api/report/attest` signs exactly this number as `weightPoints`, so a
// second copy of the formula there could drift from the one the engine then scores against.
export { compute, weightNeg } from "./score.js";
export { explain, breakdown } from "./explain.js";
export type {
  ScoreBreakdown,
  VoucherRow,
  ReportRow,
  VoucherNotCountedReason,
  ReportNotCountedReason,
} from "./explain.js";
