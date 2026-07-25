// @vouchme/mcp — src/tools/vouchme_resolve.ts — docs/06-mcp-skills.md §2.1
//
// vouchme_resolve(identifier) -> Identity. Accepts an ENS name, an address,
// or a VouchMe handle. One call, complete picture.

import { z } from "zod";
import {
  computeEngine,
  depthForJson,
  engineScoreResult,
  findAllPaths,
  getCachedGraph,
  pickCanonicalName,
  resolveIdentifierToAddress,
  scoreGraph,
  slotsFor,
  secondsToIso,
} from "../engine.js";
import { VouchMeToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  identifier: z.string().describe("An ENS name (e.g. carol.alice.vouchme.eth), a 0x address, or a bare VouchMe handle."),
};

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "vouchme_resolve",
  description:
    "Resolve an ENS name, address, or VouchMe handle to a complete identity: score, tier, depth, " +
    "credential, vouches, and the Subgraph deployment + block the answer was computed from. " +
    "Use this first for any counterparty lookup.",
  inputSchema,
  async handler(args) {
    const graph = await getCachedGraph();
    const address = resolveIdentifierToAddress(args.identifier, graph);
    if (!address) {
      return errorResult(new VouchMeToolError("NotFound", `no VouchMe account matches "${args.identifier}"`));
    }
    const account = graph.accounts.find((a) => a.id === address);
    if (!account) {
      return errorResult(new VouchMeToolError("NotFound", `no VouchMe account matches "${args.identifier}"`));
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const engineIO = computeEngine(graph, now);
    const result = engineScoreResult(engineIO.output, address);
    if (!result) {
      return errorResult(new VouchMeToolError("NotFound", `"${args.identifier}" resolved to an address the engine did not score`));
    }
    const { score, tier, depth } = result;

    const scored = scoreGraph(graph); // naming/paths only — see engine.ts's module comment
    const paths = findAllPaths(address, graph, scored);
    const canonical = pickCanonicalName(paths);
    // Multiple anchors can each independently reach the same intermediate handle (e.g. two
    // anchors both vouching the same depth-1 account), producing distinct NamedPath objects that
    // render to the identical name string — dedupe by name, not by path object, or the same alias
    // would be listed once per redundant anchor-path.
    const aliases = [...new Set(paths.filter((p) => p.name !== canonical?.name).map((p) => p.name))].sort();

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
      depth: depthForJson(depth),
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
