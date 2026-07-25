/**
 * @aval/engine — the Aval trust-mathematics scoring engine.
 *
 * A pure, dependency-free function `(edges, anchors, now) -> scores`, implementing
 * docs/01-trust-math.md end to end. No I/O, no wall-clock reads, no randomness, no floats in the
 * scoring path. See `compute()` in `score.ts` for the five-stage algorithm.
 */

export * from "./constants.js";
export * from "./types.js";
export { tenureCenti } from "./tenure.js";
// `weightNeg` is exported alongside `compute` for the same R-5 reason `score.ts` exports it to
// `explain.ts`: a consumer that needs "how much damage can this account's report do" must import
// the real formula (min(s × m⁻, cap⁻), truncated) rather than re-implement it from the constants.
// `app/src/app/api/report/attest` signs exactly this number as `weightPoints`, so a second copy of
// the formula there could drift from the one the engine then scores against.
export { compute, weightNeg } from "./score.js";
export { explain, breakdown } from "./explain.js";
export type {
  ScoreBreakdown,
  VoucherRow,
  ReportRow,
  VoucherNotCountedReason,
  ReportNotCountedReason,
} from "./explain.js";
