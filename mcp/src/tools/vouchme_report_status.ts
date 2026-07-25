// @vouchme/mcp — src/tools/vouchme_report_status.ts — docs/06-mcp-skills.md §2.12
//
// vouchme_report_status(address) -> { upheld, pending, filed, voided }
// voided: true means this account is itself under an upheld report, so
// ALL reports it has filed carry zero weight (docs/12-reporting.md §5,
// MALICIOUS-verdict propagation and the reporter-voiding rule).

import { z } from "zod";
import { getCachedGraph, resolveIdentifierToAddress } from "../engine.js";
import { currentReportWeight, fetchReportsAgainst, fetchReportsFiledBy, isVoided } from "../reports.js";
import { VouchMeToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  address: z.string().describe("The address (or ENS name / handle) to check report status for."),
};

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "vouchme_report_status",
  description:
    "Every report for and against an address, with weights, decay remaining, and challenge " +
    "deadlines. Check this before filing a new report — a second report on the same conduct " +
    "wastes a bond (only the top 3 count).",
  inputSchema,
  async handler(args, ctx) {
    const graph = await getCachedGraph();
    const address = resolveIdentifierToAddress(args.address, graph);
    if (!address) return errorResult(new VouchMeToolError("NotFound", `no VouchMe account matches "${args.address}"`));

    const now = BigInt(Math.floor(Date.now() / 1000));
    const [against, filed] = await Promise.all([
      fetchReportsAgainst(ctx.client, address),
      fetchReportsFiledBy(ctx.client, address),
    ]);

    const upheld = against
      .filter((r) => r.state === "UPHELD")
      .map((r) => ({
        reportId: r.id,
        reporter: r.reporter,
        weightPoints: r.weightPoints,
        remainingWeight: currentReportWeight(r, now),
        resolvedAt: r.resolvedAt ? new Date(Number(r.resolvedAt) * 1000).toISOString() : null,
      }));

    const pending = against
      .filter((r) => r.state === "PENDING" || r.state === "ARBITRATION")
      .map((r) => ({
        reportId: r.id,
        reporter: r.reporter,
        weightPoints: r.weightPoints,
        state: r.state,
        challengeEndsAt: new Date((Number(r.filedAt) + 72 * 3600) * 1000).toISOString(), // docs/12 §3, 72h window
      }));

    const filedList = filed.map((r) => ({
      reportId: r.id,
      target: r.target,
      weightPoints: r.weightPoints,
      state: r.state,
      voidedByReporter: false, // this list is reports *this account filed*; its own voided status is `voided` below
    }));

    return jsonResult({
      upheld,
      pending,
      filed: filedList,
      voided: isVoided(against, now),
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
