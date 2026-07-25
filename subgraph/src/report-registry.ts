// @aval/subgraph — src/report-registry.ts
//
// Handlers for every event ReportRegistry emits (docs/12-reporting.md §5).
// Report weight decay (180d, linear after UPHELD) is computed at read time
// by @aval/engine from `filedAt`/`resolvedAt`/`state` — the same
// query-time-predicate principle as vouch expiry (docs/05 §2.3), applied
// here to report weight instead. ReportDecayed is indexed for the
// timeline view only and deliberately does not mutate Report.

import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";
import { ReportFiled, Rebutted, Escalated, Resolved, ReportDecayed } from "../generated/ReportRegistry/ReportRegistry";
import { Rebuttal, Report } from "../generated/schema";

const REPORT_STATE_NAMES = ["NONE", "PENDING", "ARBITRATION", "UPHELD", "UNPROVEN", "MALICIOUS", "WITHDRAWN"];

export function handleReportFiled(event: ReportFiled): void {
  const report = new Report(event.params.id);
  report.reporter = event.params.reporter;
  report.target = event.params.target;
  report.evidenceHash = event.params.evidenceHash;
  // Entity field is `snapshotWeight` (docs/05 §2.1.1 / docs/01 §7.1's
  // terminology), sourced from the ABI's `weightPoints` event param
  // (docs/12-reporting.md §5) — the on-chain name and the Subgraph's
  // stored-attribute name differ deliberately; see schema.graphql's
  // comment on Report.snapshotWeight.
  report.snapshotWeight = event.params.weightPoints.toI32();
  report.bond = event.params.bond;
  report.filedAt = event.block.timestamp;
  report.resolvedAt = null;
  report.rebuttalTotal = BigInt.zero();
  report.rebutterCount = 0;
  report.state = "PENDING";
  report.jurors = [];
  report.txHash = event.transaction.hash;
  report.save();
}

export function handleRebutted(event: Rebutted): void {
  const report = Report.load(event.params.id);
  if (report == null) {
    log.warning("Rebutted for unknown report {}", [event.params.id.toHexString()]);
    return;
  }

  const rebuttal = new Rebuttal(event.transaction.hash.concatI32(event.logIndex.toI32()));
  rebuttal.report = report.id;
  rebuttal.voucher = event.params.voucher;
  rebuttal.stake = event.params.stake;
  rebuttal.at = event.block.timestamp;
  rebuttal.txHash = event.transaction.hash;
  rebuttal.save();

  report.rebuttalTotal = report.rebuttalTotal.plus(event.params.stake);
  report.rebutterCount += 1;
  report.save();
}

export function handleEscalated(event: Escalated): void {
  const report = Report.load(event.params.id);
  if (report == null) {
    log.warning("Escalated for unknown report {}", [event.params.id.toHexString()]);
    return;
  }
  const jurors: Bytes[] = [];
  const params = event.params.jurors;
  for (let i = 0; i < params.length; i++) {
    jurors.push(params[i]);
  }
  report.jurors = jurors;
  report.state = "ARBITRATION";
  report.save();
}

export function handleResolved(event: Resolved): void {
  const report = Report.load(event.params.id);
  if (report == null) {
    log.warning("Resolved for unknown report {}", [event.params.id.toHexString()]);
    return;
  }
  const outcome = event.params.outcome;
  report.state = outcome >= 0 && outcome < REPORT_STATE_NAMES.length ? REPORT_STATE_NAMES[outcome] : "NONE";
  report.resolvedAt = event.params.at;
  report.save();
}

export function handleReportDecayed(event: ReportDecayed): void {
  // Intentionally a no-op on entity state: decay is a query-time
  // predicate the engine applies from `filedAt`/`resolvedAt`/`now`
  // (docs/12-reporting.md §5 — "changes no protocol state"). This handler
  // exists so the event is indexed (available to a raw aval_query / a
  // timeline UI) without introducing a second, mutable source of truth
  // for "current" report weight alongside the derived one.
  log.info("ReportDecayed: report={} remainingPoints={}", [
    event.params.id.toHexString(),
    event.params.remainingPoints.toString(),
  ]);
}
