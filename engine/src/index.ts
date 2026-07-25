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
export { compute } from "./score.js";
export { explain, breakdown } from "./explain.js";
export type {
  ScoreBreakdown,
  VoucherRow,
  ReportRow,
  VoucherNotCountedReason,
  ReportNotCountedReason,
} from "./explain.js";
