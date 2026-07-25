// @vouchme/mcp — src/tools/vouchme_query.ts — docs/06-mcp-skills.md §2.15
//
// vouchme_query(graphql, variables?) -> any. Raw GraphQL against the VouchMe
// Subgraph. "Every good MCP has a door out; agents find questions we
// didn't anticipate."

import { z } from "zod";
import { getCachedGraph } from "../engine.js";
import { jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  graphql: z.string().describe("A raw GraphQL query or mutation string against the VouchMe Subgraph."),
  variables: z.record(z.string(), z.unknown()).optional().describe("GraphQL variables, if the query uses any."),
};

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "vouchme_query",
  description:
    "Escape hatch: run a raw GraphQL query against the VouchMe Subgraph directly. Prefer the named " +
    "tools (vouchme_resolve, vouchme_score, etc.) when one fits — this exists for questions they don't " +
    "anticipate, not as the default entry point.",
  inputSchema,
  async handler(args, ctx) {
    // Included for the subgraphDeployment/computedAtBlock envelope even
    // on a raw query — see docs/06 §3's design rule table.
    const cached = await getCachedGraph();
    const { data } = await ctx.client.query<unknown>(args.graphql, args.variables ?? {});
    return jsonResult({
      data,
      subgraphDeployment: cached.meta.deploymentId,
      computedAtBlock: cached.meta.blockNumber,
    });
  },
};
