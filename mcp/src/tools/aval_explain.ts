// @aval/mcp — src/tools/aval_explain.ts — docs/06-mcp-skills.md §2.3
//
// aval_explain(address) -> string (prose). Built for agents that must
// justify a decision to a human. The last line — the weakest link — is
// the part users act on.

import { z } from "zod";
import {
  computeEngine,
  deriveBreakdown,
  engineScoreResult,
  getCachedGraph,
  nameOf,
  resolveIdentifierToAddress,
  scoreGraph,
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
  async handler(args) {
    const graph = await getCachedGraph();
    const address = resolveIdentifierToAddress(args.address, graph);
    if (!address) {
      return errorResult(new AvalToolError("NotFound", `no Aval account matches "${args.address}"`));
    }

    const now = BigInt(Math.floor(Date.now() / 1000));
    const engineIO = computeEngine(graph, now);
    const result = engineScoreResult(engineIO.output, address);
    if (!result) {
      return errorResult(new AvalToolError("NotFound", `"${args.address}" resolved to an address the engine did not score`));
    }
    const { score, tier, depth } = result;

    const scored = scoreGraph(graph); // naming only — see engine.ts's module comment
    const name = nameOf(address, graph, scored);
    const { breakdown } = deriveBreakdown(address, graph, engineIO, (a) => nameOf(a, graph, scored));

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
      lines.push(`A vouch from ${b.voucher} does NOT count: ${describeExcludedReason(b.reason, b.voucherDepth, depth)}`);
    }

    const gateVouchers = counted.length;
    const passesScore = score >= T1;
    const passesVouchers = gateVouchers >= 2;
    const passesDepth = Number.isFinite(depth) && depth <= 3 && depth > 0;
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
      if (!passesDepth) {
        failed.push(
          !Number.isFinite(depth)
            ? "unreachable — no active path to an anchor"
            : depth === 0
              ? "no active path to an anchor"
              : `depth ${depth} exceeds max_depth`,
        );
      }
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
    lines.push(`Computed from ${graph.meta.deploymentId} at block ${graph.meta.blockNumber}.`);

    return textResult(lines.join("\n"));
  },
};

/** Prose for one excluded breakdown row, keyed off @aval/engine's own VoucherNotCountedReason
 *  (explain.ts) — never a single hardcoded "anti-collusion ordering" explanation for every
 *  exclusion reason, several of which have nothing to do with depth ordering. */
function describeExcludedReason(reason: string | undefined, voucherDepth: number, depth: number): string {
  switch (reason) {
    case "voucher_depth_not_lower":
      return (
        `it is excluded by the anti-collusion ordering rule — its voucher depth (${voucherDepth}) ` +
        `is not lower than this account's depth (${Number.isFinite(depth) ? depth : "unreachable"}).`
      );
    case "vouch_inactive":
      return "the vouch is not currently active (revoked or expired).";
    case "voucher_not_human":
      return "the voucher is not a human account.";
    case "voucher_unreachable":
      return "the voucher itself has no active path to an anchor.";
    case "anchor_ignores_inbound":
      return "this account is an anchor — anchors ignore every inbound vouch by design.";
    default:
      return `it does not count (${reason ?? "unknown reason"}).`;
  }
}
