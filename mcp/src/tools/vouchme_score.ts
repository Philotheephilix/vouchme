// @vouchme/mcp — src/tools/vouchme_score.ts — docs/06-mcp-skills.md §2.2
//
// vouchme_score(address) -> { score, tier, depth, breakdown[] }. The
// `counted: false` rows matter more than the counted ones — this is where
// an agent learns the anti-collusion rule (docs/01-trust-math.md) by
// observing it, rather than by us documenting it. Zero-contribution rows
// are always included, never filtered out (docs/06 §3 design rule).

import { z } from "zod";
import {
  computeEngine,
  depthForJson,
  deriveBreakdown,
  engineScoreResult,
  getCachedGraph,
  isLikelyAddress,
  nameOf,
  resolveIdentifierToAddress,
  scoreGraph,
} from "../engine.js";
import { VouchMeToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  address: z.string().describe("The address (or ENS name / handle) to score."),
};

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "vouchme_score",
  description:
    "Get an address's score, tier, and depth with the full per-voucher breakdown, including " +
    "vouches that contributed ZERO because they failed the anti-collusion ordering rule " +
    "(voucher must be at a strictly lower depth). Use this, not vouchme_resolve, when you need to " +
    "explain *why* a score is what it is.",
  inputSchema,
  async handler(args) {
    const graph = await getCachedGraph();
    const address = isLikelyAddress(args.address) ? args.address.toLowerCase() : resolveIdentifierToAddress(args.address, graph);
    if (!address || !graph.accounts.some((a) => a.id === address)) {
      return errorResult(new VouchMeToolError("NotFound", `no VouchMe account matches "${args.address}"`));
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const engineIO = computeEngine(graph, now);
    const result = engineScoreResult(engineIO.output, address);
    if (!result) {
      return errorResult(new VouchMeToolError("NotFound", `"${args.address}" resolved to an address the engine did not score`));
    }
    const { score, tier, depth } = result;

    const scored = scoreGraph(graph); // naming only — see engine.ts's module comment
    const { breakdown, base } = deriveBreakdown(address, graph, engineIO, (a) => nameOf(a, graph, scored));

    return jsonResult({
      score,
      tier,
      depth: depthForJson(depth),
      breakdown,
      // docs/06 §2.2's example shows an empty `reports: []` — this
      // scaffold's graph query (see engine.ts) doesn't fetch reports, so
      // it is always empty here; wiring ReportRegistry data through is a
      // follow-up, not a silent omission.
      reports: [],
      base,
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
