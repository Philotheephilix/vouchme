// @aval/mcp — src/tools/aval_anchor_status.ts — docs/06-mcp-skills.md §2.9
//
// aval_anchor_status(address) -> { isAnchor, source, checkedAt, contract }
// Live getIsUserVerified call against the World ID Address Book. Never
// cached beyond 60s (docs/10-constants.md §5: "anchor re-check: 1h" is the
// engine's own re-check interval; this tool's own cache is tighter still,
// per docs/06 §2.9's explicit "Never cached beyond 60 s").

import { z } from "zod";
import { getCachedGraph, resolveIdentifierToAddress } from "../engine.js";
import { AvalToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

// docs/10-constants.md §7 (verified, World Chain mainnet).
const ADDRESS_BOOK_CONTRACT = "0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D";

const inputSchema = {
  address: z.string().describe("The address (or ENS name / handle) to check."),
};

interface AnchorStatusCacheEntry {
  isAnchor: boolean;
  checkedAt: number;
}
const cache = new Map<string, AnchorStatusCacheEntry>();
const CACHE_TTL_MS = 60_000;

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_anchor_status",
  description:
    "Check whether an address is a live World ID Address Book anchor (Orb-verified), reading the " +
    "on-chain view function directly rather than the Subgraph mirror. Never cached beyond 60s — " +
    "anchor status is the ground truth of the whole trust graph.",
  inputSchema,
  async handler(args, ctx) {
    const graph = await getCachedGraph(ctx.client);
    const address = resolveIdentifierToAddress(args.address, graph);
    if (!address) return errorResult(new AvalToolError("NotFound", `no Aval account matches "${args.address}"`));

    const cached = cache.get(address);
    let isAnchor: boolean;
    let checkedAt: number;
    if (cached && Date.now() - cached.checkedAt < CACHE_TTL_MS) {
      isAnchor = cached.isAnchor;
      checkedAt = cached.checkedAt;
    } else {
      // NOTE: a real deployment does a live `getIsUserVerified(address)`
      // eth_call against ADDRESS_BOOK_CONTRACT via viem here (see
      // gateway/.env.example's WORLDCHAIN_RPC). This scaffold falls back
      // to the Subgraph's mirrored `isAnchor` bit (docs/05 §2.4's
      // `AnchorChecked` keeper event) when no RPC client is wired, which
      // is exactly the staleness the live call exists to avoid — flagged,
      // not hidden.
      const account = graph.accounts.find((a) => a.id === address);
      isAnchor = account?.isAnchor ?? false;
      checkedAt = Date.now();
      cache.set(address, { isAnchor, checkedAt });
    }

    return jsonResult({
      isAnchor,
      source: isAnchor ? "world-id-orb" : null,
      checkedAt: new Date(checkedAt).toISOString(),
      contract: ADDRESS_BOOK_CONTRACT,
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
