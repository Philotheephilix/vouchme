// @aval/mcp — src/reports.ts
//
// Shared ReportRegistry data access for aval_report, aval_report_status,
// and aval_gate's fraud-related context. Kept separate from engine.ts
// (which is about the positive-trust graph) because reports are a
// different subgraph.yaml data source (ReportRegistry) with their own
// entities (Report, Rebuttal — see subgraph/schema.graphql).

import type { GraphClient } from "./client.js";

export type ReportState = "NONE" | "PENDING" | "ARBITRATION" | "UPHELD" | "UNPROVEN" | "MALICIOUS" | "WITHDRAWN";

export interface ReportRecord {
  id: string;
  reporter: string;
  target: string;
  evidenceHash: string;
  /** docs/06-mcp-skills.md §2.12b's public field name — the tool response contract this repo's
   *  docs use. Sourced from the Subgraph's `Report.snapshotWeight` (see the GraphQL queries below
   *  and subgraph/schema.graphql's comment on that field for why the two names differ). */
  weightPoints: number;
  bond: string; // BigInt as decimal string (AVAL, 18 decimals — left as the Subgraph's raw units)
  filedAt: bigint;
  resolvedAt: bigint | null;
  rebuttalTotal: string;
  rebutterCount: number;
  state: ReportState;
}

// Two separate queries rather than one with both filters optional: in
// graph-node, an omitted `where` key is "no filter" but an explicit `null`
// value is "field IS null" — passing an unused variable through a shared
// `where: { reporter: $reporter, target: $target }` would silently filter
// out every result on whichever side wasn't intended to be used.
// Subgraph field is `snapshotWeight` (subgraph/schema.graphql — renamed from
// the contract ABI's `weightPoints` per docs/05-graph-data-layer.md §2.1.1 /
// docs/01-trust-math.md §7.1); `toRecord()` below maps it onto this module's
// `ReportRecord.weightPoints`, the name docs/06's tool response contract uses.
const REPORTS_AGAINST_QUERY = /* GraphQL */ `
  query ReportsAgainst($target: Bytes!, $first: Int!) {
    reports(first: $first, orderBy: filedAt, orderDirection: desc, where: { target: $target }) {
      id reporter target evidenceHash snapshotWeight bond filedAt resolvedAt rebuttalTotal rebutterCount state
    }
  }
`;

const REPORTS_BY_QUERY = /* GraphQL */ `
  query ReportsBy($reporter: Bytes!, $first: Int!) {
    reports(first: $first, orderBy: filedAt, orderDirection: desc, where: { reporter: $reporter }) {
      id reporter target evidenceHash snapshotWeight bond filedAt resolvedAt rebuttalTotal rebutterCount state
    }
  }
`;

interface ReportsQueryResult {
  reports: {
    id: string;
    reporter: string;
    target: string;
    evidenceHash: string;
    snapshotWeight: number;
    bond: string;
    filedAt: string;
    resolvedAt: string | null;
    rebuttalTotal: string;
    rebutterCount: number;
    state: ReportState;
  }[];
}

function toRecord(r: ReportsQueryResult["reports"][number]): ReportRecord {
  return {
    id: r.id,
    reporter: r.reporter.toLowerCase(),
    target: r.target.toLowerCase(),
    evidenceHash: r.evidenceHash,
    weightPoints: r.snapshotWeight,
    bond: r.bond,
    filedAt: BigInt(r.filedAt),
    resolvedAt: r.resolvedAt ? BigInt(r.resolvedAt) : null,
    rebuttalTotal: r.rebuttalTotal,
    rebutterCount: r.rebutterCount,
    state: r.state,
  };
}

export async function fetchReportsAgainst(client: GraphClient, target: string, first = 100): Promise<ReportRecord[]> {
  const { data } = await client.query<ReportsQueryResult>(REPORTS_AGAINST_QUERY, { target, first });
  return data.reports.map(toRecord);
}

export async function fetchReportsFiledBy(client: GraphClient, reporter: string, first = 100): Promise<ReportRecord[]> {
  const { data } = await client.query<ReportsQueryResult>(REPORTS_BY_QUERY, { reporter, first });
  return data.reports.map(toRecord);
}

const REPORT_DECAY_DAYS = 180; // docs/10-constants.md §9

/** Report weight at `now`, linearly decayed after an UPHELD verdict (docs/12-reporting.md §5). */
export function currentReportWeight(report: ReportRecord, now: bigint): number {
  if (report.state !== "UPHELD" || report.resolvedAt === null) return report.weightPoints;
  const ageDays = Number(now - report.resolvedAt) / 86400;
  const remaining = Math.max(0, 1 - ageDays / REPORT_DECAY_DAYS);
  return report.weightPoints * remaining;
}

/** True if `address` has any live UPHELD report against it, per docs/06 §2.12b — voids all of their own filed reports. */
export function isVoided(reportsAgainstThem: ReportRecord[], now: bigint): boolean {
  return reportsAgainstThem.some((r) => r.state === "UPHELD" && currentReportWeight(r, now) > 0);
}
