// @aval/mcp — src/tools/aval_gate.ts — docs/06-mcp-skills.md §2.4
//
// aval_gate(address, policy) -> { allow, reasons, score, tier }. The one
// most integrations will use. Always returns `reasons: string[]`, never a
// bare boolean (docs/06 §3: "Agents must be able to explain refusals").

import { z } from "zod";
import {
  deriveBreakdown,
  findPath,
  getCachedGraph,
  nameOf,
  resolveIdentifierToAddress,
  runEngineCompute,
  scoreGraph,
  preferEngineResult,
} from "../engine.js";
import { AvalToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const policySchema = z.object({
  minTier: z.number().int().min(0).max(2).optional(),
  minScore: z.number().optional(),
  maxDepth: z.number().int().optional(),
  requireCredential: z.array(z.string()).optional(),
  requireAnchorPath: z.boolean().optional(),
  minVouchers: z.number().int().optional(),
  excludeFraudulent: z.boolean().optional(),
});

const inputSchema = {
  address: z.string().describe("The address (or ENS name / handle) to gate."),
  policy: policySchema.describe("The policy to evaluate against — see docs/06-mcp-skills.md §2.4."),
};

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_gate",
  description:
    "Evaluate a trust policy against an address in one call: minTier, minScore, maxDepth, " +
    "requireCredential, requireAnchorPath, minVouchers, excludeFraudulent. Returns allow/deny " +
    "plus named reasons for every failed check — never assemble this decision from aval_score " +
    "yourself; the gates (score AND >=2 distinct vouchers AND a path to an anchor) are not the " +
    "same thing as the score alone. Use this for any irreversible action toward a counterparty.",
  inputSchema,
  async handler(args, ctx) {
    const graph = await getCachedGraph(ctx.client);
    const address = resolveIdentifierToAddress(args.address, graph);
    if (!address) {
      return errorResult(new AvalToolError("NotFound", `no Aval account matches "${args.address}"`));
    }
    const account = graph.accounts.find((a) => a.id === address)!;

    const scored = scoreGraph(graph);
    const local = scored.scores.get(address) ?? { score: 10, tier: 0 as const, depth: 0 };
    const engineOutput = runEngineCompute(graph, BigInt(Math.floor(Date.now() / 1000)));
    const { score, tier, depth } = preferEngineResult(engineOutput, address, local);
    const { breakdown } = deriveBreakdown(address, graph, scored, (a) => nameOf(a, graph, scored));
    const distinctVouchers = breakdown.filter((b) => b.counted).length;

    const policy = args.policy;
    const reasons: string[] = [];

    if (policy.excludeFraudulent !== false && account.status === "FRAUDULENT") {
      reasons.push("account is fraudulent");
    }
    if (policy.minTier !== undefined && tier < policy.minTier) {
      reasons.push(`tier ${tier} < required ${policy.minTier}`);
    }
    if (policy.minScore !== undefined && score < policy.minScore) {
      reasons.push(`score ${score} < required ${policy.minScore}`);
    }
    if (policy.maxDepth !== undefined && depth > policy.maxDepth) {
      reasons.push(`depth ${depth} > allowed max ${policy.maxDepth}`);
    }
    if (policy.minVouchers !== undefined && distinctVouchers < policy.minVouchers) {
      reasons.push(`${distinctVouchers} active voucher${distinctVouchers === 1 ? "" : "s"} < required ${policy.minVouchers}`);
    }
    if (policy.requireCredential && policy.requireCredential.length > 0 && !policy.requireCredential.includes(account.credential)) {
      reasons.push(`credential "${account.credential}" not in required set [${policy.requireCredential.join(", ")}]`);
    }
    if (policy.requireAnchorPath) {
      const path = findPath(address, "anchor", graph, scored);
      if (!path) reasons.push("no active path to an anchor");
    }

    return jsonResult({
      allow: reasons.length === 0,
      reasons,
      score,
      tier,
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
