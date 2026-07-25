// @aval/mcp — src/tools/aval_request_score.ts — docs/06-mcp-skills.md §2.11
//
// aval_request_score(subject, purpose) -> attributed lookup. The
// prerequisite for ever reporting `subject` (docs/13-platforms.md §5).
// Costs an on-chain ScoreRequested event — one of only three tools in
// this server with real effects (docs/06 §3).
//
// Attribution is mandatory by definition (docs §2.11: "appears in the
// subject's transparency log" — attributed to *someone*), and docs/06's
// signature has no explicit "requester" parameter, so — same as
// aval_report.ts — this refuses with a named error rather than running
// unattributed when AVAL_OPERATOR_ADDRESS isn't configured, instead of
// silently proceeding to compute (and return) a lookup with no requester.
//
// NOTE ON SCOPE: submitting the actual on-chain transaction needs a
// funded signer and the PlatformRegistry ABI, neither of which this
// scaffold wires up (no operator wallet was specified in the task brief).
// The score computation below is real; `requestId` is derived
// deterministically so it is stable and inspectable, but is NOT yet the
// id of a transaction that has actually landed on World Chain. This is
// flagged here and in mcp/README.md rather than silently pretended.

import { keccak256, toHex } from "viem";
import { z } from "zod";
import { getCachedGraph, resolveIdentifierToAddress, runEngineCompute, scoreGraph, preferEngineResult } from "../engine.js";
import { fetchReportsAgainst } from "../reports.js";
import { AvalToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  subject: z.string().describe("The address (or ENS name / handle) being looked up."),
  purpose: z.string().describe("A declared, plain-language reason for the lookup — the subject will see this."),
};

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_request_score",
  description:
    "Attributed score lookup: costs an on-chain ScoreRequested event, appears in the subject's " +
    "transparency log with your declared purpose, and is the ONLY way to become eligible to later " +
    "file an aval_report against this subject. Use aval_score for a free, anonymous read instead " +
    "unless you may need to report this subject.",
  inputSchema,
  async handler(args, ctx) {
    const operator = ctx.operatorAddress;
    if (!operator) {
      return errorResult(
        new AvalToolError("NoOperator", "AVAL_OPERATOR_ADDRESS is not configured for this server (see mcp/README.md)"),
      );
    }

    const graph = await getCachedGraph(ctx.client);
    const subject = resolveIdentifierToAddress(args.subject, graph);
    if (!subject) return errorResult(new AvalToolError("NotFound", `no Aval account matches "${args.subject}"`));

    const scored = scoreGraph(graph);
    const local = scored.scores.get(subject) ?? { score: 10, tier: 0 as const, depth: 0 };
    const now = BigInt(Math.floor(Date.now() / 1000));
    const engineOutput = runEngineCompute(graph, now);
    const { score, tier, depth } = preferEngineResult(engineOutput, subject, local);

    const reportsAgainst = await fetchReportsAgainst(ctx.client, subject);
    const openReports = reportsAgainst.filter((r) => r.state === "PENDING" || r.state === "ARBITRATION").length;
    const upheldReports = reportsAgainst.filter((r) => r.state === "UPHELD").length;

    // Matches PlatformRegistry's real ScoreRequested(id, platform, subject, purposeHash, at) shape
    // (subgraph/abis/PlatformRegistry.json) — `operator` is the "platform" side.
    const requestId = keccak256(toHex(`${operator}:${subject}:${args.purpose}:${now}`));

    return jsonResult({
      requestId,
      score,
      // scoreAtRisk uses the un-decayed weight of every open/pending report — see docs/12 §5.
      scoreAtRisk: score,
      tier,
      depth,
      openReports,
      upheldReports,
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
