// @aval/mcp — src/tools/aval_explain.ts — docs/06-mcp-skills.md §2.3
//
// aval_explain(address) -> string (prose). Built for agents that must
// justify a decision to a human. The last line — the weakest link — is
// the part users act on.

import { z } from "zod";
import {
  deriveBreakdown,
  getCachedGraph,
  nameOf,
  resolveIdentifierToAddress,
  runEngineCompute,
  scoreGraph,
  preferEngineResult,
  T1,
} from "../engine.js";
import { AvalToolError, errorResult, textResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  address: z.string().describe("The address (or ENS name / handle) to explain."),
};

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "aval_explain",
  description:
    "Explain an address's score in prose: which vouches counted, which didn't and why, the " +
    "promotion gates it does or doesn't pass, and its single weakest link. Use this after " +
    "aval_gate refuses someone, to give the human a reason.",
  inputSchema,
  async handler(args, ctx) {
    const graph = await getCachedGraph(ctx.client);
    const address = resolveIdentifierToAddress(args.address, graph);
    if (!address) {
      return errorResult(new AvalToolError("NotFound", `no Aval account matches "${args.address}"`));
    }

    const scored = scoreGraph(graph);
    const local = scored.scores.get(address) ?? { score: 10, tier: 0 as const, depth: 0 };
    const engineOutput = runEngineCompute(graph, BigInt(Math.floor(Date.now() / 1000)));
    const { score, tier, depth } = preferEngineResult(engineOutput, address, local);
    const name = nameOf(address, graph, scored);
    const { breakdown } = deriveBreakdown(address, graph, scored, (a) => nameOf(a, graph, scored));

    const counted = breakdown.filter((b) => b.counted);
    const excluded = breakdown.filter((b) => !b.counted);

    const lines: string[] = [];
    lines.push(`${name || address} — score ${score.toFixed(1)}, Tier ${tier}.`);
    lines.push("");

    if (counted.length === 0) {
      lines.push("No active vouches currently count toward this score.");
    } else {
      const parts = counted
        .map((b) => `${b.voucher} (score ${b.voucherScore}, depth ${b.voucherDepth}), contributing ${b.contribution.toFixed(2)}${b.capped ? " (capped)" : ""}`)
        .join("; ");
      lines.push(`${counted.length} active vouch${counted.length === 1 ? "" : "es"} count toward the score: ${parts}.`);
    }

    for (const b of excluded) {
      lines.push(
        `A vouch from ${b.voucher} does NOT count: it is excluded by the anti-collusion ordering ` +
          `rule (${b.reason}) — its voucher depth (${b.voucherDepth}) is not lower than this account's depth (${depth}).`,
      );
    }

    const gateVouchers = counted.length;
    const passesScore = score >= T1;
    const passesVouchers = gateVouchers >= 2;
    const passesDepth = depth <= 3 && depth > 0;
    lines.push("");
    if (passesScore && passesVouchers && passesDepth) {
      lines.push(
        `Passes all three promotion gates: score ${score.toFixed(1)} >= ${T1}, ${gateVouchers} distinct vouchers, ` +
          `and a ${depth}-hop path to an anchor.`,
      );
    } else {
      const failed: string[] = [];
      if (!passesScore) failed.push(`score ${score.toFixed(1)} < ${T1}`);
      if (!passesVouchers) failed.push(`${gateVouchers} active voucher${gateVouchers === 1 ? "" : "s"} < required 2`);
      if (!passesDepth) failed.push(depth === 0 ? "no active path to an anchor" : `depth ${depth} exceeds max_depth`);
      lines.push(`Does not pass Tier 1: ${failed.join("; ")}.`);
    }

    if (counted.length > 0) {
      const weakest = [...counted].sort((a, b) => (a.expiresAt ?? "").localeCompare(b.expiresAt ?? ""))[0];
      if (weakest?.expiresAt) {
        lines.push("");
        lines.push(`Weakest link: the vouch from ${weakest.voucher}, expiring ${weakest.expiresAt}.`);
      }
    }

    lines.push("");
    lines.push(`Computed from Subgraph ${graph.meta.deploymentId} at block ${graph.meta.blockNumber}.`);

    return textResult(lines.join("\n"));
  },
};
