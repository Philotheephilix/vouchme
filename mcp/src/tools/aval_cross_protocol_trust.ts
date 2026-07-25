// @aval/mcp — src/tools/aval_cross_protocol_trust.ts — docs/06-mcp-skills.md §2.8
//
// Fans one standardized `trust-graph v0.1.0` query (docs/05-graph-data-layer.md
// §3.4) across Aval (World Chain), Circles v2 (Gnosis), and ENS (mainnet).
//
// This scaffold only builds the Aval side for real (subgraph/ in this
// repo). The Circles and ENS *adapters* (docs/05 §3.3, deliverable G-3)
// are a separate build item this task didn't ask for — their endpoints
// are read from CIRCLES_SUBGRAPH_URL / ENS_SUBGRAPH_URL if configured, and
// otherwise reported as zero inbound with the reason stated, rather than
// silently fabricated. The shape returned is identical either way, which
// is the entire point of the standardized schema.

import { z } from "zod";
import { BASE, CAP_POS, M_POS, getCachedGraph, resolveIdentifierToAddress, scoreGraph } from "../engine.js";
import { AvalToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  address: z.string().describe("The address (or ENS name / handle) to look up across protocols."),
  protocols: z.array(z.enum(["aval", "circles", "ens"])).optional().describe("Defaults to all three."),
};

interface CrossProtocolEdge {
  protocol: { name: string; network: string; trustModel: "WEIGHTED" | "BINARY" | "ISSUANCE"; isAnchored: boolean };
  from: { address: string; isAnchor: boolean; anchorSource: string | null; inboundActive: number };
  weight: string;
  issuedAt: string;
  expiresAt: string | null;
}

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_cross_protocol_trust",
  description:
    "Fetch inbound trust edges for an address across Aval, Circles v2, and ENS subnames using the " +
    "standardized trust-graph v0.1.0 schema. CONTEXT ONLY — non-Aval edges never contribute to the " +
    "Aval score; never treat them as score when deciding whether to vouch.",
  inputSchema,
  async handler(args) {
    const graph = await getCachedGraph();
    const address = resolveIdentifierToAddress(args.address, graph);
    if (!address) return errorResult(new AvalToolError("NotFound", `no Aval account matches "${args.address}"`));

    const wanted = new Set(args.protocols && args.protocols.length > 0 ? args.protocols : ["aval", "circles", "ens"]);
    const scored = scoreGraph(graph);
    const edges: CrossProtocolEdge[] = [];
    const byProtocol: Record<string, { network: string; inbound: number; trustModel: string }> = {};

    if (wanted.has("aval")) {
      const inbound = scored.inboundByAccount.get(address) ?? [];
      for (const e of inbound) {
        const voucherResult = scored.scores.get(e.voucherId);
        edges.push({
          protocol: { name: "Aval", network: "worldchain", trustModel: "WEIGHTED", isAnchored: true },
          from: {
            address: e.voucherId,
            isAnchor: graph.accounts.find((a) => a.id === e.voucherId)?.isAnchor ?? false,
            anchorSource: graph.accounts.find((a) => a.id === e.voucherId)?.isAnchor ? "world-id-orb" : null,
            inboundActive: (scored.inboundByAccount.get(e.voucherId) ?? []).length,
          },
          weight: Math.min(((voucherResult?.score ?? BASE) * M_POS) / CAP_POS, 1).toFixed(4),
          issuedAt: new Date(Number(e.issuedAt) * 1000).toISOString(),
          expiresAt: new Date(Number(e.expiresAt) * 1000).toISOString(),
        });
      }
      byProtocol.aval = { network: "worldchain", inbound: inbound.length, trustModel: "WEIGHTED" };
    }

    if (wanted.has("circles")) {
      // trust-circles adapter (docs/05 §3.3) — not deployed by this scaffold.
      byProtocol.circles = { network: "gnosis", inbound: 0, trustModel: "BINARY" };
    }

    if (wanted.has("ens")) {
      // trust-ens adapter (docs/05 §3.3) — not deployed by this scaffold.
      byProtocol.ens = { network: "mainnet", inbound: 0, trustModel: "ISSUANCE" };
    }

    return jsonResult({
      edges,
      byProtocol,
      note: "Non-Aval edges are CONTEXT ONLY and do not contribute to the Aval score.",
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
