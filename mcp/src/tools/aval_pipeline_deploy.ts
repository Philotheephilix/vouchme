// @aval/mcp — src/tools/aval_pipeline_deploy.ts — docs/06-mcp-skills.md §2.14
//
// aval_pipeline_deploy(previewId) -> { protocolSlug, firstBlock,
// sinkStatus, query }
//
// Refuses any preview where eventsFound == 0 — "a pipeline that deploys
// cleanly and indexes nothing is indistinguishable from a working one
// until somebody queries it a week later, so the gate is in the tool
// rather than in the documentation." That gate is real and enforced below
// even though the deploy step itself is stubbed (see aval_pipeline_preview.ts).

import { z } from "zod";
import { getPreview } from "../pipelines.js";
import { getCachedGraph } from "../engine.js";
import { AvalToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  previewId: z.string().describe("A previewId returned by aval_pipeline_preview."),
};

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_pipeline_deploy",
  description:
    "Deploy a previously previewed Substreams pipeline. Refuses with NoEventsFound if the preview " +
    "found zero matching events — always call aval_pipeline_preview first and check eventsFound.",
  inputSchema,
  async handler(args, ctx) {
    const graph = await getCachedGraph(ctx.client);
    const preview = getPreview(args.previewId);
    if (!preview) {
      return errorResult(new AvalToolError("PreviewNotFound", `no preview "${args.previewId}" (previews expire after 30 minutes)`));
    }
    if (preview.eventsFound === 0) {
      return errorResult(
        new AvalToolError("NoEventsFound", "refusing to deploy: the preview found 0 matching events (docs/06-mcp-skills.md §2.14)"),
      );
    }

    // STUB: a real implementation submits the manifest to Substreams and
    // wires the resulting sink into the trust-graph v0.1.0 schema
    // (docs/05-graph-data-layer.md §3.2). See mcp/README.md's scope note.
    const protocolSlug = preview.description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 40);

    return jsonResult({
      protocolSlug: protocolSlug || `pipeline-${args.previewId}`,
      firstBlock: graph.meta.blockNumber,
      sinkStatus: "PENDING",
      query: `{ trustEdges(where: { protocol: "${protocolSlug}" }, first: 10) { from { address } to { address } weight } }`,
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
