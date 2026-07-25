// @aval/mcp — src/tools/aval_anchor_status.ts — docs/06-mcp-skills.md §2.9
//
// aval_anchor_status(address) -> { isAnchor, source, checkedAt, contract }
//
// Live getIsUserVerified call against GenesisAnchorBook — the testnet stand-in for World ID's
// Address Book on World Chain Sepolia (deployments/worldchain-sepolia.json: the real Address Book
// does not exist on this network). `source` is read live from the contract's own `anchorSource()`
// rather than assumed — it reports "genesis-testnet", never "world-id-orb"; presenting a genesis
// anchor as an Orb anchor would forge the one externally-grounded fact in the protocol.
//
// Never cached beyond 60s (docs/06 §2.9: "anchor status is the ground truth of the whole trust
// graph") — this tool's own cache below is separate from, and tighter than, getCachedGraph()'s 5s
// trust-graph cache, and bypasses it entirely rather than reading the graph's mirrored isAnchor
// bit.

import { z } from "zod";
import { checkAnchorStatusLive, getCachedGraph, resolveIdentifierToAddress } from "../engine.js";
import { AvalToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  address: z.string().describe("The address (or ENS name / handle) to check."),
};

interface AnchorStatusCacheEntry {
  isAnchor: boolean;
  source: string | null;
  contract: string;
  checkedAt: number;
}
const cache = new Map<string, AnchorStatusCacheEntry>();
const CACHE_TTL_MS = 60_000;

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_anchor_status",
  description:
    "Check whether an address is a live World Chain Sepolia GenesisAnchorBook anchor (this " +
    "deployment's testnet stand-in for World ID's Address Book), reading the on-chain view " +
    "function directly rather than a cached mirror. Never cached beyond 60s — anchor status is " +
    "the ground truth of the whole trust graph.",
  inputSchema,
  async handler(args) {
    const graph = await getCachedGraph();
    const address = resolveIdentifierToAddress(args.address, graph);
    if (!address) return errorResult(new AvalToolError("NotFound", `no Aval account matches "${args.address}"`));

    const cached = cache.get(address);
    let entry: AnchorStatusCacheEntry;
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      entry = cached;
    } else {
      const live = await checkAnchorStatusLive(address as `0x${string}`);
      entry = {
        isAnchor: live.isAnchor,
        source: live.isAnchor ? live.anchorSource : null,
        contract: live.contract,
        checkedAt: Date.now(),
      };
      cache.set(address, entry);
    }

    return jsonResult({
      isAnchor: entry.isAnchor,
      source: entry.source,
      checkedAt: new Date(entry.checkedAt).toISOString(),
      contract: entry.contract,
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
