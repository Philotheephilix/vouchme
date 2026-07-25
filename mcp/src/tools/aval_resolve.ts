// @aval/mcp — src/tools/aval_resolve.ts — docs/06-mcp-skills.md §2.1
//
// aval_resolve(identifier) -> Identity. Accepts an ENS name, an address,
// or an Aval handle. One call, complete picture.

import { z } from "zod";
import {
  findAllPaths,
  getCachedGraph,
  pickCanonicalName,
  resolveIdentifierToAddress,
  runEngineCompute,
  scoreGraph,
  slotsFor,
  preferEngineResult,
  secondsToIso,
} from "../engine.js";
import { AvalToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  identifier: z.string().describe("An ENS name (e.g. carol.alice.aval.eth), a 0x address, or a bare Aval handle."),
};

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_resolve",
  description:
    "Resolve an ENS name, address, or Aval handle to a complete identity: score, tier, depth, " +
    "credential, vouches, and the Subgraph deployment + block the answer was computed from. " +
    "Use this first for any counterparty lookup.",
  inputSchema,
  async handler(args, ctx) {
    const graph = await getCachedGraph(ctx.client);
    const address = resolveIdentifierToAddress(args.identifier, graph);
    if (!address) {
      return errorResult(new AvalToolError("NotFound", `no Aval account matches "${args.identifier}"`));
    }
    const account = graph.accounts.find((a) => a.id === address);
    if (!account) {
      return errorResult(new AvalToolError("NotFound", `no Aval account matches "${args.identifier}"`));
    }

    const scored = scoreGraph(graph);
    const local = scored.scores.get(address) ?? { score: 10, tier: 0 as const, depth: 0 };
    const engineOutput = runEngineCompute(graph, BigInt(Math.floor(Date.now() / 1000)));
    const { score, tier, depth } = preferEngineResult(engineOutput, address, local);

    const paths = findAllPaths(address, graph, scored);
    const canonical = pickCanonicalName(paths);
    const aliases = paths.filter((p) => p.name !== canonical?.name).map((p) => p.name).sort();

    const inbound = scored.inboundByAccount.get(address) ?? [];
    const outbound = scored.outboundByAccount.get(address) ?? [];
    const slots = slotsFor(tier);

    const status = account.status === "ACTIVE" ? "active" : account.status.toLowerCase();

    return jsonResult({
      address,
      canonicalName: canonical?.name ?? "",
      aliases,
      score,
      tier,
      depth,
      credential: account.credential,
      credentialExpiresAt: secondsToIso(account.credentialExpiresAt),
      isAnchor: account.isAnchor,
      vouchesIn: inbound.length,
      vouchesOut: outbound.length,
      slots,
      status,
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
