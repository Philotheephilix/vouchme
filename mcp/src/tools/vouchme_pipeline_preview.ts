// @vouchme/mcp — src/tools/vouchme_pipeline_preview.ts — docs/06-mcp-skills.md §2.14
//
// vouchme_pipeline_preview(description, chain) -> { previewId, params,
// decodedSample[], eventsFound }
//
// Natural language -> a Substreams pipeline preview (docs/14-substreams.md
// §3). This scaffold does not implement the NL -> Substreams manifest
// codegen backend (see mcp/README.md's scope note); it implements the
// documented tool *shape*, including the safety property
// vouchme_pipeline_deploy depends on: a preview that finds no events must be
// refused at deploy time, not silently indexed as empty.

import { z } from "zod";
import { newPreviewId, savePreview } from "../pipelines.js";
import { getCachedGraph } from "../engine.js";
import { jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  description: z.string().describe('Plain-language description of the events to index, e.g. "trust edges on Circles v2".'),
  chain: z.string().describe('Target chain slug, e.g. "gnosis", "mainnet", "worldchain".'),
};

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "vouchme_pipeline_preview",
  description:
    "Preview a Substreams pipeline generated from a natural-language description before deploying " +
    "it. Always check eventsFound before calling vouchme_pipeline_deploy — a preview with 0 events " +
    "found will be refused at deploy time.",
  inputSchema,
  async handler(args) {
    const graph = await getCachedGraph();

    // STUB: a real implementation resolves `description` to a contract +
    // event signature (via an LLM pass over a verified ABI, per docs/14
    // §3.1) and decodes a handful of recent blocks on `chain` to produce
    // decodedSample/eventsFound. Absent that backend, this returns a
    // structurally valid, honestly-empty preview so vouchme_pipeline_deploy's
    // refusal path is exercised rather than silently bypassed.
    const previewId = newPreviewId();
    const preview = {
      previewId,
      description: args.description,
      chain: args.chain,
      params: { description: args.description, chain: args.chain },
      decodedSample: [] as unknown[],
      eventsFound: 0,
      createdAt: Date.now(),
    };
    savePreview(preview);

    return jsonResult({
      previewId,
      params: preview.params,
      decodedSample: preview.decodedSample,
      eventsFound: preview.eventsFound,
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
