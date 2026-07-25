// @aval/mcp — src/tools/aval_platform.ts — docs/06-mcp-skills.md §2.13
//
// aval_platform(nameOrAddress) -> { score, tier, vouchers[], bond,
// reportsFiled, reportsUpheld, upheldRate, policyURI, requestsLast30d }
//
// `upheldRate` and `requestsLast30d` together are the number that
// matters: a platform that queried 40 000 people and reported 12 is
// behaving very differently from one that queried 12 and reported 12.

import { z } from "zod";
import { getCachedGraph, nameOf, resolveIdentifierToAddress, scoreGraph } from "../engine.js";
import { countRequestsLast30d, fetchPlatform } from "../platforms.js";
import { fetchReportsFiledBy } from "../reports.js";
import { AvalToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  nameOrAddress: z.string().describe("The platform's ENS name (under aval.eth) or address."),
};

// docs/13-platforms.md §3
const M_POS = 0.25;
const CAP_POS = 20;

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_platform",
  description:
    "Look up a registered platform: its score (granted entirely by human vouchers, since " +
    "platforms cannot vouch for anything), bond, vouchers, and its report track record — " +
    "reportsFiled/reportsUpheld/upheldRate together tell you whether it reports responsibly.",
  inputSchema,
  async handler(args, ctx) {
    const graph = await getCachedGraph(ctx.client);
    const address = resolveIdentifierToAddress(args.nameOrAddress, graph) ?? args.nameOrAddress.toLowerCase();

    const result = await fetchPlatform(ctx.client, address);
    if (!result) {
      return errorResult(new AvalToolError("NotFound", `no registered platform matches "${args.nameOrAddress}"`));
    }
    const { platform, vouches } = result;

    const scored = scoreGraph(graph);
    const now = BigInt(Math.floor(Date.now() / 1000));

    // s_P(p) = sum(min(s+(h) * 0.25, 20)) over active human vouchers (docs/13 §3).
    // Reports-against-platform subtraction is left at the positive-only
    // term — see engine.ts's module comment on why this scaffold's graph
    // query doesn't include reports.
    let score = 0;
    const voucherRows: { human: string; expiresAt: string }[] = [];
    for (const v of vouches) {
      if (v.expiresAt <= now) continue;
      const humanResult = scored.scores.get(v.human);
      const humanScore = humanResult?.score ?? 10;
      score += Math.min(humanScore * M_POS, CAP_POS);
      voucherRows.push({ human: nameOf(v.human, graph, scored), expiresAt: new Date(Number(v.expiresAt) * 1000).toISOString() });
    }
    const tier = score >= 150 ? 2 : score >= 40 ? 1 : 0; // P2 / P1 / P0 — docs/13 §3

    const reportsFiledList = await fetchReportsFiledBy(ctx.client, platform.id);
    const reportsFiled = reportsFiledList.length;
    const reportsUpheld = reportsFiledList.filter((r) => r.state === "UPHELD").length;
    const upheldRate = reportsFiled > 0 ? reportsUpheld / reportsFiled : 0;
    const requestsLast30d = await countRequestsLast30d(ctx.client, platform.id, now);

    return jsonResult({
      score,
      tier,
      vouchers: voucherRows,
      bond: platform.bond,
      reportsFiled,
      reportsUpheld,
      upheldRate,
      policyURI: platform.policyURI,
      requestsLast30d,
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
