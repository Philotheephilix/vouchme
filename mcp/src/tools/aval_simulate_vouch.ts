// @aval/mcp — src/tools/aval_simulate_vouch.ts — docs/06-mcp-skills.md §2.5
//
// aval_simulate_vouch(voucher, target) -> { before, after, delta, promotes, cost, downstream }.
// Read-only, no transaction. "Look before you spend a slot" — including
// second-order effects on people the voucher has never met.

import { z } from "zod";
import {
  getCachedGraph,
  nameOf,
  resolveIdentifierToAddress,
  scoreGraph,
  secondsToIso,
  slotsFor,
  T1,
  type GraphVouch,
  type TrustGraph,
} from "../engine.js";
import { AvalToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  voucher: z.string().describe("The prospective voucher — address, ENS name, or handle."),
  target: z.string().describe("The prospective vouchee — address, ENS name, or handle."),
};

const VOUCH_EXPIRY_SECONDS = 90n * 24n * 60n * 60n; // docs/10-constants.md §5
const RATE_LIMIT_SECONDS = 24n * 60n * 60n;

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_simulate_vouch",
  description:
    "Simulate a vouch from `voucher` to `target` without submitting a transaction: score/tier " +
    "before and after, whether it promotes the target, the voucher's slot cost, and downstream " +
    "score changes for people the voucher has never met (target's own vouchees).",
  inputSchema,
  async handler(args, ctx) {
    const graph = await getCachedGraph(ctx.client);
    const voucherAddr = resolveIdentifierToAddress(args.voucher, graph);
    const targetAddr = resolveIdentifierToAddress(args.target, graph);
    if (!voucherAddr) return errorResult(new AvalToolError("NotFound", `no Aval account matches voucher "${args.voucher}"`));
    if (!targetAddr) return errorResult(new AvalToolError("NotFound", `no Aval account matches target "${args.target}"`));

    const voucherAccount = graph.accounts.find((a) => a.id === voucherAddr)!;

    const before = scoreGraph(graph);
    const beforeTarget = before.scores.get(targetAddr) ?? { score: 10, tier: 0 as const, depth: 0 };
    const voucherResult = before.scores.get(voucherAddr) ?? { score: 10, tier: 0 as const, depth: 0 };

    if (voucherResult.tier === 0) {
      return errorResult(
        new AvalToolError("InsufficientTier", "voucher is Tier 0 and cannot vouch (FR-3, docs/10-constants.md §2)"),
      );
    }

    const slotsTotal = slotsFor(voucherResult.tier);
    const slotsUsed = voucherAccount.activeOutboundCount;
    if (slotsUsed >= slotsTotal) {
      return errorResult(new AvalToolError("NoSlots", `voucher has ${slotsUsed}/${slotsTotal} slots used`));
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const simulatedEdge: GraphVouch = {
      voucherId: voucherAddr,
      voucheeId: targetAddr,
      issuedAt: now,
      expiresAt: now + VOUCH_EXPIRY_SECONDS,
    };
    const simulatedGraph: TrustGraph = { ...graph, vouches: [...graph.vouches, simulatedEdge] };
    const after = scoreGraph(simulatedGraph);
    const afterTarget = after.scores.get(targetAddr)!;

    const lastIssuedAt = (before.outboundByAccount.get(voucherAddr) ?? []).reduce<bigint>(
      (max, e) => (e.issuedAt > max ? e.issuedAt : max),
      0n,
    );
    const rateLimitedUntil = lastIssuedAt > 0n ? lastIssuedAt + RATE_LIMIT_SECONDS : now;

    const beforeVouchees = before.outboundByAccount.get(targetAddr) ?? [];
    const downstream = beforeVouchees.map((edge) => {
      const b = before.scores.get(edge.voucheeId);
      const a = after.scores.get(edge.voucheeId);
      return {
        address: edge.voucheeId,
        name: nameOf(edge.voucheeId, graph, before),
        scoreBefore: b?.score ?? 10,
        scoreAfter: a?.score ?? 10,
      };
    });

    return jsonResult({
      before: { score: beforeTarget.score, tier: beforeTarget.tier },
      after: { score: afterTarget.score, tier: afterTarget.tier },
      delta: afterTarget.score - beforeTarget.score,
      promotes: afterTarget.tier > beforeTarget.tier || (beforeTarget.score < T1 && afterTarget.score >= T1),
      cost: {
        slotsBefore: slotsTotal - slotsUsed,
        slotsAfter: slotsTotal - slotsUsed - 1,
        rateLimitedUntil: secondsToIso(rateLimitedUntil > now ? rateLimitedUntil : now + RATE_LIMIT_SECONDS),
      },
      downstream,
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
