// @aval/mcp — src/tools/aval_path.ts — docs/06-mcp-skills.md §2.6
//
// aval_path(from, to) -> { hops, length, weakestLink }
// aval_path(address, "anchor") -> shortest path to any anchor

import { z } from "zod";
import { findPath, getCachedGraph, resolveIdentifierToAddress, scoreGraph } from "../engine.js";
import { AvalToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  from: z.string().describe("Starting address, ENS name, or handle."),
  to: z.string().describe('Target address/ENS name/handle, or the literal string "anchor" for the nearest anchor.'),
};

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_path",
  description:
    'Find the shortest active-vouch path between two accounts, or from an account to the nearest ' +
    'anchor (pass to="anchor"). Returns the ENS names along the path and the weakest link — the ' +
    "edge expiring soonest, i.e. the first thing that would break this chain.",
  inputSchema,
  async handler(args) {
    const graph = await getCachedGraph();
    const fromAddr = resolveIdentifierToAddress(args.from, graph);
    if (!fromAddr) return errorResult(new AvalToolError("NotFound", `no Aval account matches "${args.from}"`));

    let toParam = args.to;
    if (toParam !== "anchor") {
      const toAddr = resolveIdentifierToAddress(args.to, graph);
      if (!toAddr) return errorResult(new AvalToolError("NotFound", `no Aval account matches "${args.to}"`));
      toParam = toAddr;
    }

    const scored = scoreGraph(graph);
    const path = findPath(fromAddr, toParam, graph, scored);
    if (!path) {
      return errorResult(
        new AvalToolError("NoConnection", `no active vouch path from "${args.from}" to "${args.to}" within max_depth`),
      );
    }

    return jsonResult({
      hops: path.hops,
      length: path.length,
      weakestLink: path.weakestLink,
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
