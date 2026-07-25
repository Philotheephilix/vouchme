// @aval/mcp — src/tools/aval_cross_protocol_trust.ts — docs/06-mcp-skills.md §2.8
//
// Fans ONE standardized query across every protocol and chain indexed under the Trust Graph
// Standard v0.2.0 (docs/17-trust-graph-standard.md).
//
// This is the MCP layer of the standard: an agent asks about an address once and gets back trust
// edges from Aval on World Chain and EAS on Base / Optimism / Arbitrum / Ethereum — in ONE shape,
// from ONE query. The tool contains no per-protocol branching at all, because the shared schema
// removed the need for any: registering Circles tomorrow changes this file not at all.
//
// The cross-protocol side is served by the standardized `trust_edges` store that the composable
// Substreams package writes (substreams/service's GET /cross-protocol). When that service is not
// running the tool says so by name — it never fabricates an edge, and never reports zero as
// though it had checked.

import { z } from "zod";
import { BASE, CAP_POS, M_POS, getCachedGraph, resolveIdentifierToAddress, scoreGraph } from "../engine.js";
import { AvalToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

/** Where the standardized trust-edge store is served from (substreams/service/server.mjs). */
const TRUST_GRAPH_SERVICE_URL = process.env.TRUST_GRAPH_SERVICE_URL ?? "http://127.0.0.1:8790";

/**
 * Budget for the Aval-specific engine read. It is an enrichment, not the answer, so it gets a
 * deadline rather than an unbounded await.
 */
const ENGINE_TIMEOUT_MS = Number(process.env.AVAL_ENGINE_TIMEOUT_MS ?? 8_000);

type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

/** Resolve a promise within `ms`, reporting a named failure instead of throwing or hanging. */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<Attempt<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
      }),
    ]);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const inputSchema = {
  address: z.string().describe("The address (or ENS name / Aval handle) to look up across protocols."),
  protocols: z
    .array(z.string())
    .optional()
    .describe("Restrict to these protocol slugs (e.g. ['aval','eas']). Defaults to every indexed protocol."),
  liveOnly: z
    .boolean()
    .optional()
    .describe(
      "Apply the standard's liveness predicate: not revoked, and not past expiry (treating the " +
        "perpetual sentinel as live). Defaults to true."
    ),
};

/** trust-graph v0.2.0's TrustEdge, exactly as the standardized store serves it. */
interface StandardEdge {
  protocol: string;
  network: string;
  scope: string;
  from: string;
  to: string;
  kind: string;
  weightRaw: string;
  issuedAt: string;
  expiresAt: string;
  perpetual: boolean;
  revoked: boolean;
  blockNum: number;
  txHash: string;
  /** Only ever set for Aval edges — see the normalization note in the handler. */
  avalWeight?: string;
}

interface ServiceResponse {
  edges?: StandardEdge[];
}

/**
 * Read the standardized store. Returns a named failure rather than an empty result when the
 * service is unreachable, so "nothing found" and "could not look" stay distinguishable.
 */
async function fetchStandardEdges(
  address: string,
  liveOnly: boolean
): Promise<{ ok: true; data: ServiceResponse } | { ok: false; reason: string }> {
  const url =
    `${TRUST_GRAPH_SERVICE_URL}/cross-protocol` +
    `?address=${encodeURIComponent(address)}&direction=inbound&liveOnly=${liveOnly}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { ok: false, reason: `trust-graph service returned HTTP ${res.status}` };
    return { ok: true, data: (await res.json()) as ServiceResponse };
  } catch (err) {
    return {
      ok: false,
      reason:
        `trust-graph service unreachable at ${TRUST_GRAPH_SERVICE_URL} ` +
        `(${err instanceof Error ? err.message : String(err)}). ` +
        `Start it with: node substreams/service/server.mjs`,
    };
  }
}

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_cross_protocol_trust",
  description:
    "Fetch inbound trust edges for an address across EVERY protocol indexed under the Trust Graph " +
    "Standard v0.2.0 (Aval on World Chain, EAS on Base/Optimism/Arbitrum/Ethereum) using one " +
    "standardized query. CONTEXT ONLY — non-Aval edges never contribute to the Aval score; never " +
    "treat them as score when deciding whether to vouch.",
  inputSchema,
  async handler(args) {
    const liveOnly = args.liveOnly ?? true;

    // The standardized store is the PRIMARY path and is queried without the Aval engine, because
    // it already carries Aval's own edges alongside every other protocol's — that is the point of
    // a shared schema. The engine below is strictly an enrichment step, so a slow or failing
    // Aval-specific chain read degrades this tool instead of hanging it.
    //
    // Concretely: `getCachedGraph()` replays AvalRegistry logs over a chunked `eth_getLogs` scan,
    // which is a bespoke, single-protocol, single-chain code path — exactly the kind of thing the
    // standard exists to stop every consumer from having to own. It is bounded here rather than
    // awaited unconditionally.
    const graph = await withTimeout(getCachedGraph(), ENGINE_TIMEOUT_MS);

    // Resolve through Aval's own account index when it is available (this accepts ENS names and
    // Aval handles); otherwise accept a raw address, since a subject may exist on EAS and not on
    // Aval at all — refusing those would defeat the point of a cross-protocol lookup.
    const resolved = graph.ok ? resolveIdentifierToAddress(args.address, graph.value) : null;
    const address = (resolved ?? args.address).toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) {
      return errorResult(
        new AvalToolError(
          "NotFound",
          graph.ok
            ? `"${args.address}" is not a known Aval account and is not an address`
            : `"${args.address}" is not an address, and the Aval account index needed to resolve ` +
              `names is unavailable (${graph.reason})`
        )
      );
    }

    const wanted = args.protocols?.length ? new Set(args.protocols) : null;
    const edges: StandardEdge[] = [];
    const byProtocol: Record<string, { protocol: string; network: string; inbound: number }> = {};
    const unavailable: string[] = [];
    const countEdge = (e: StandardEdge) => {
      const key = `${e.protocol}:${e.network}`;
      byProtocol[key] ??= { protocol: e.protocol, network: e.network, inbound: 0 };
      byProtocol[key].inbound += 1;
    };

    // ── The standardized store: every protocol at once, no per-protocol code ────────────────
    const store = await fetchStandardEdges(address, liveOnly);
    if (store.ok) {
      for (const e of store.data.edges ?? []) {
        if (wanted && !wanted.has(e.protocol)) continue;
        edges.push(e);
        countEdge(e);
      }
    } else {
      unavailable.push(store.reason);
    }

    // ── Aval's own live engine state ────────────────────────────────────────────────────────
    // Kept separate from the store deliberately. The standard records the raw edge, but an Aval
    // vouch's EFFECTIVE weight depends on the voucher's own current score — graph-wide state, not
    // a per-event fact, and so correctly absent from `weight_raw`
    // (docs/17-trust-graph-standard.md §5.4). This block is the adapter layer performing exactly
    // the normalization the standard leaves to its consumers.
    if (!graph.ok) {
      unavailable.push(
        `Aval engine enrichment skipped (${graph.reason}) — Aval edges below come from the ` +
          `standardized store and carry no avalWeight`
      );
    } else if (!wanted || wanted.has("aval")) {
      const scored = scoreGraph(graph.value);
      for (const e of scored.inboundByAccount.get(address) ?? []) {
        const voucher = e.voucherId.toLowerCase();
        const weight = Math.min(((scored.scores.get(e.voucherId)?.score ?? BASE) * M_POS) / CAP_POS, 1).toFixed(4);
        const existing = edges.find((x) => x.protocol === "aval" && x.from.toLowerCase() === voucher);
        if (existing) {
          existing.avalWeight = weight;
          continue;
        }
        // In the live contract read but not yet in the sink — the sink indexes a block range and
        // the chain moves on. Included and attributed, rather than dropped or backdated.
        const edge: StandardEdge = {
          protocol: "aval",
          network: "worldchain",
          scope: "",
          from: e.voucherId,
          to: address,
          kind: "VOUCH",
          weightRaw: "1",
          issuedAt: new Date(Number(e.issuedAt) * 1000).toISOString(),
          expiresAt: new Date(Number(e.expiresAt) * 1000).toISOString(),
          perpetual: false,
          revoked: false,
          blockNum: 0,
          txHash: "",
          avalWeight: weight,
        };
        edges.push(edge);
        countEdge(edge);
      }
    }

    return jsonResult({
      address,
      schema: "trust-graph v0.2.0",
      spec: "docs/17-trust-graph-standard.md",
      liveOnly,
      count: edges.length,
      byProtocol: Object.values(byProtocol),
      edges,
      // Only ever populated with a real, named failure — never used to paper over an empty result.
      ...(unavailable.length ? { unavailable } : {}),
      note:
        "Non-Aval edges are CONTEXT ONLY and do not contribute to the Aval score: importing " +
        "another protocol's edges would import its Sybil surface (docs/05-graph-data-layer.md §3.5). " +
        "`weightRaw` is protocol-native and NOT comparable across protocols; `avalWeight` is the " +
        "only normalized figure here, and exists only for Aval edges.",
      computedAtBlock: graph.ok ? graph.value.meta.blockNumber : null,
    });
  },
};
