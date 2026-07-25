// @aval/mcp — src/tools/aval_history.ts — docs/06-mcp-skills.md §2.10
//
// aval_history(address, from?, to?, points?) -> [{ block, timestamp, score, tier }]
//
// Time-travel queries against the Subgraph, engine re-run per point. No
// snapshot table exists (docs/05-graph-data-layer.md §2.5) — this is
// derived, and it is a good demonstration of why the graph belongs in a
// Subgraph. `from`/`to` are block numbers here (not timestamps): the
// Subgraph's time-travel mechanism (`block: { number }`) is block-indexed,
// and converting a wall-clock timestamp to a block number needs a chain's
// block time, which isn't one of this scaffold's fetched fields — an
// honest simplification rather than a guessed one.
//
// docs shows this as a bare array; wrapped as `{ points, subgraphDeployment,
// computedAtBlock }` for the same reason as aval_candidates (see that
// file's comment and the final report's "resolved ambiguities" section).

import { z } from "zod";
import { fetchGraph, getCachedGraph, resolveIdentifierToAddress, scoreGraph } from "../engine.js";
import { AvalToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  address: z.string().describe("The address (or ENS name / handle) to trace."),
  from: z.number().int().optional().describe("Starting block number. Defaults to (latest - 4 * spacing)."),
  to: z.number().int().optional().describe("Ending block number. Defaults to the latest indexed block."),
  points: z.number().int().min(1).max(50).optional().describe("Number of samples between from and to. Default 5."),
};

// World Chain is an OP-stack L2; ~2s blocks is the standard OP-stack
// default. Used only to *estimate* a display timestamp for historical
// blocks — the Subgraph's `_meta` does not expose a timestamp for
// arbitrary historical blocks, only for the latest indexed one.
const ESTIMATED_BLOCK_TIME_SECONDS = 2;

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_history",
  description:
    "Trace an address's score and tier over a block range by re-running the engine at each " +
    "historical block — no snapshot table, fully re-derived. Powers 'watch the score move'.",
  inputSchema,
  async handler(args, ctx) {
    const latest = await getCachedGraph(ctx.client);
    const address = resolveIdentifierToAddress(args.address, latest);
    if (!address) return errorResult(new AvalToolError("NotFound", `no Aval account matches "${args.address}"`));

    const points = args.points ?? 5;
    const to = args.to ?? latest.meta.blockNumber;
    const spacing = 1000; // arbitrary default stride between samples when `from` is unset
    const from = args.from ?? Math.max(0, to - spacing * (points - 1));
    const now = Math.floor(Date.now() / 1000);

    const blockNumbers: number[] = [];
    for (let i = 0; i < points; i++) {
      const b = points === 1 ? to : Math.round(from + ((to - from) * i) / (points - 1));
      blockNumbers.push(b);
    }

    const result: { block: number; timestamp: string; score: number; tier: number }[] = [];
    for (const block of blockNumbers) {
      // Each historical point is a full graph refetch pinned to `block`,
      // deliberately bypassing getCachedGraph's cache (which only ever
      // holds the latest block).
      const graph = block === latest.meta.blockNumber ? latest : await fetchGraph(ctx.client, undefined, block);
      const scored = scoreGraph(graph);
      const r = scored.scores.get(address) ?? { score: 10, tier: 0 as const, depth: 0 };
      const estimatedSeconds = now - (latest.meta.blockNumber - block) * ESTIMATED_BLOCK_TIME_SECONDS;
      result.push({
        block,
        timestamp: new Date(estimatedSeconds * 1000).toISOString(),
        score: r.score,
        tier: r.tier,
      });
    }

    return jsonResult({
      points: result,
      subgraphDeployment: latest.meta.deploymentId,
      computedAtBlock: latest.meta.blockNumber,
    });
  },
};
