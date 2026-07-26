import "server-only";

import type { Address } from "./session";

/**
 * Lend's own log of the reports it has filed.
 *
 * THIS RECORD IS IN MEMORY AND IS LOST ON RESTART, exactly like `claims.ts`. The consequence is
 * different though, and milder: the authoritative record of a report is the `ReportFiled` event on
 * World Chain, not this map. Losing this map loses Lend's ability to SHOW you what it filed; it
 * does not un-file anything, and it cannot double-file — `ReportRegistry` enforces a 180-day
 * cooldown per (reporter, target) pair and a concurrent-open-report cap on chain.
 *
 * A real deployment reads its report list back from the chain (or a Subgraph) instead of keeping
 * one here. This file is the shape of that, not a substitute for it.
 */

export interface ReportRecord {
  /** Resolved subject address — always an address, even when the report was filed by name. */
  target: Address;
  /** What the reporter typed: a name like `mallory` or a raw address. Kept verbatim so the log
   *  shows what was actually reported, not a normalised form nobody entered. */
  subjectInput: string;
  /** VouchMe's name for the subject at filing time, when they have one. */
  ensName: string | null;
  reasonCode: string;
  /** The evidence note stays on Lend. Only its hash goes on chain (docs/12-reporting.md §5), so
   *  this is the only copy of the words themselves. */
  note: string;
  evidenceHash: string;
  /** Report weight in the engine's centi-points, as attested. Drives the bond. */
  weightPoints: number;
  bondWei: string;
  /** The World App wallet that asked Lend to file. Lend's bond pays for it, so who asked is part
   *  of the record. */
  requestedBy: Address;
  scoreRequestTxHash: string | null;
  fileTxHash: string;
  at: number;
}

// Pinned to `globalThis` for the same reason as claims.ts: Next gives each route handler its own
// module instance, so a module-level Map would be written by the route and read as empty by the
// page.
const store = globalThis as typeof globalThis & { __lendReports?: ReportRecord[] };
const reports: ReportRecord[] = (store.__lendReports ??= []);

export function recordReport(record: ReportRecord): void {
  reports.unshift(record);
}

/** Newest first. */
export function listReports(): readonly ReportRecord[] {
  return reports;
}

/** Reports Lend has already filed against this subject, so the page can show the on-chain
 *  180-day cooldown as something already known rather than as a surprise revert. */
export function reportsAgainst(target: Address): readonly ReportRecord[] {
  return reports.filter((r) => r.target.toLowerCase() === target.toLowerCase());
}

// The reason vocabulary lives in `reasons.ts`, which is NOT server-only — the client form needs the
// same list, and two lists would eventually disagree about what a valid reason is.
export { REASON_CODES, isReasonCode, reasonLabel, type ReasonCode } from "./reasons";
