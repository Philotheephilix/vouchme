// @aval/mcp — src/tools/aval_candidates.ts — docs/06-mcp-skills.md §2.7
//
// aval_candidates(address) -> [{ candidate, distance, freeSlots, wouldPromote, sharedNeighbours }]
//
// docs/06 shows this as a bare array. Design rule §3 requires every
// response to carry subgraphDeployment + computedAtBlock, which a bare
// array cannot do — resolved by wrapping the array as `candidates` inside
// an envelope object alongside those two fields (see mcp/README.md's
// "resolved ambiguities" note).

import { z } from "zod";
import { findCandidates, getCachedGraph, resolveIdentifierToAddress, scoreGraph } from "../engine.js";
import { AvalToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  address: z.string().describe("The address (or ENS name / handle) looking for more vouchers."),
};

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_candidates",
  description:
    "Who could vouch for this person: accounts within 2 hops of their existing vouchers, with " +
    "free slots, at a depth low enough to actually contribute. Turns \"get more vouches\" into a " +
    "list of names — use this instead of telling a user to vaguely go get vouched for.",
  inputSchema,
  async handler(args) {
    const graph = await getCachedGraph();
    const address = resolveIdentifierToAddress(args.address, graph);
    if (!address) return errorResult(new AvalToolError("NotFound", `no Aval account matches "${args.address}"`));

    const scored = scoreGraph(graph);
    const candidates = findCandidates(address, graph, scored);

    return jsonResult({
      candidates,
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
