// @aval/mcp — src/tools/aval_query.ts — docs/06-mcp-skills.md §2.15
//
// aval_query(graphql, variables?) -> any. Raw GraphQL against the Aval
// Subgraph. "Every good MCP has a door out; agents find questions we
// didn't anticipate."

import { z } from "zod";
import { getCachedGraph } from "../engine.js";
import { jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  graphql: z.string().describe("A raw GraphQL query or mutation string against the Aval Subgraph."),
  variables: z.record(z.string(), z.unknown()).optional().describe("GraphQL variables, if the query uses any."),
};

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_query",
  description:
    "Escape hatch: run a raw GraphQL query against the Aval Subgraph directly. Prefer the named " +
    "tools (aval_resolve, aval_score, etc.) when one fits — this exists for questions they don't " +
    "anticipate, not as the default entry point.",
  inputSchema,
  async handler(args, ctx) {
    // Included for the subgraphDeployment/computedAtBlock envelope even
    // on a raw query — see docs/06 §3's design rule table.
    const cached = await getCachedGraph(ctx.client);
    const { data } = await ctx.client.query<unknown>(args.graphql, args.variables ?? {});
    return jsonResult({
      data,
      subgraphDeployment: cached.meta.deploymentId,
      computedAtBlock: cached.meta.blockNumber,
    });
  },
};
