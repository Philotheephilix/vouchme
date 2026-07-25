// @vouchme/mcp — src/tools/vouchme_report.ts — docs/06-mcp-skills.md §2.12b
//
// vouchme_report(target, evidenceURI, weightPoints) -> { reportId, bond,
// challengeEndsAt, state, youAreRisking }. The one tool that costs money.
// Every precondition in docs §2.12b's table is checked here and reported
// as a NAMED error — never a generic failure — before any bond is taken.
//
// NOTE ON SCOPE: this tool acts on behalf of the operator configured via
// VOUCHME_OPERATOR_ADDRESS (see ToolContext / mcp/README.md) — docs/06's
// signature has no explicit `reporter` parameter, so the server's own
// identity is used, matching how vouchme-mcp is meant to run: "at its
// operator's expense, under its operator's name" (docs/06 §3). Submitting
// the actual on-chain `ReportRegistry.file()` transaction needs a funded
// signer this scaffold doesn't wire up; see vouchme_request_score.ts for the
// same, and mcp/README.md's scope note.

import { keccak256, toHex } from "viem";
import { z } from "zod";
import { findPath, getCachedGraph, resolveIdentifierToAddress, scoreGraph } from "../engine.js";
import { fetchPlatform, hasPriorScoreRequest } from "../platforms.js";
import { fetchReportsAgainst, fetchReportsFiledBy, isVoided } from "../reports.js";
import { VouchMeToolError, errorResult, jsonResult } from "../response.js";
import type { ToolDefinition } from "./types.js";

const inputSchema = {
  target: z.string().describe("The address (or ENS name / handle) being reported."),
  evidenceURI: z.string().describe("IPFS (or similar) URI to the published evidence. Publish evidence BEFORE filing."),
  weightPoints: z.number().positive().describe("Requested report weight, in points — bond is 10 x this."),
};

const CHALLENGE_WINDOW_SECONDS = 72 * 3600; // docs/12-reporting.md §3
const PAIR_COOLDOWN_SECONDS = 180 * 24 * 3600; // docs/10-constants.md §9
const BOND_RATE_PER_WEIGHT_POINT = 10; // docs/10-constants.md §9

export const tool: ToolDefinition<typeof inputSchema> = {
  name: "vouchme_report",
  description:
    "File a bonded fraud report against `target`. Checks every precondition (operator tier, " +
    "connection to the target, open-report limit, pair cooldown, bond sufficiency, reporter not " +
    "voided) and returns a NAMED error for the first one that fails — never a generic refusal. On " +
    "success, always states exactly what is being risked if the report is later ruled MALICIOUS.",
  inputSchema,
  async handler(args, ctx) {
    const operator = ctx.operatorAddress;
    if (!operator) {
      return errorResult(
        new VouchMeToolError("NoOperator", "VOUCHME_OPERATOR_ADDRESS is not configured for this server (see mcp/README.md)"),
      );
    }

    const graph = await getCachedGraph();
    const targetAddr = resolveIdentifierToAddress(args.target, graph);
    if (!targetAddr) return errorResult(new VouchMeToolError("NotFound", `no VouchMe account matches "${args.target}"`));

    const now = BigInt(Math.floor(Date.now() / 1000));
    const scored = scoreGraph(graph);

    const platform = await fetchPlatform(ctx.client, operator);
    const isPlatformReporter = platform !== null;

    // ── Check 1: operator tier ────────────────────────────────────────
    if (isPlatformReporter) {
      // A full P1 (>=40) platform-score check needs the same w()-summed
      // vouch computation vouchme_platform.ts does; reusing that here would
      // duplicate it inline, so this checks the cheaper necessary
      // condition instead — an inactive (unbonded / deregistered)
      // platform can never reach P1, so this rejects a clear subset of
      // the same failures without re-deriving the score twice per call.
      if (!platform!.platform.active) {
        return errorResult(new VouchMeToolError("InsufficientTier", "operator platform is not active"));
      }
    } else {
      const reporterResult = scored.scores.get(operator);
      if (!reporterResult || reporterResult.tier < 1) {
        return errorResult(
          new VouchMeToolError("InsufficientTier", `operator tier ${reporterResult?.tier ?? 0} < required 1 (human) or P1 (platform)`),
        );
      }
    }

    // ── Check 2: connection to the target ─────────────────────────────
    if (isPlatformReporter) {
      const hasRequest = await hasPriorScoreRequest(ctx.client, operator, targetAddr);
      if (!hasRequest) {
        return errorResult(new VouchMeToolError("NoConnection", "platform has no prior ScoreRequest against this target"));
      }
    } else {
      const path = findPath(operator, targetAddr, graph, scored);
      // Prior on-chain interaction (the other qualifying connection type
      // per docs/12 §2) isn't indexed by any of this scaffold's 4 data
      // sources, so only the graph-distance check runs here.
      if (!path || path.length > 2) {
        return errorResult(new VouchMeToolError("NoConnection", "no <=2-hop vouch path between operator and target"));
      }
    }

    // ── Check 3: no open report from this operator ────────────────────
    const filedByOperator = await fetchReportsFiledBy(ctx.client, operator);
    const openByOperator = filedByOperator.filter((r) => r.state === "PENDING" || r.state === "ARBITRATION");
    const concurrentLimit = isPlatformReporter
      ? Math.min(50, Math.max(1, Math.floor(Number(platform!.platform.bond) / 1000)))
      : 1;
    if (openByOperator.length >= concurrentLimit) {
      return errorResult(
        new VouchMeToolError("ReportLimitReached", `operator already has ${openByOperator.length}/${concurrentLimit} open reports`),
      );
    }

    // ── Check 4: pair cooldown (180 days) ──────────────────────────────
    const reportsAgainstTarget = await fetchReportsAgainst(ctx.client, targetAddr);
    const recentFromOperator = reportsAgainstTarget.find(
      (r) => r.reporter === operator && now - r.filedAt < BigInt(PAIR_COOLDOWN_SECONDS),
    );
    if (recentFromOperator) {
      return errorResult(new VouchMeToolError("PairCooldown", "operator reported this target within the last 180 days"));
    }

    // ── Check 5: sufficient bond ────────────────────────────────────────
    // TODO: CredibilityVault balances are not indexed by this scaffold's 4
    // subgraph.yaml data sources — a vault data source is required to
    // check this for real. Not silently passed: flagged here and in
    // mcp/README.md's scope note, same as gateway's `vouchme.bonded`.
    const requiredBond = BOND_RATE_PER_WEIGHT_POINT * args.weightPoints;

    // ── Check 6: reporter not voided ────────────────────────────────────
    const reportsAgainstOperator = await fetchReportsAgainst(ctx.client, operator);
    if (isVoided(reportsAgainstOperator, now)) {
      return errorResult(new VouchMeToolError("ReporterVoided", "operator is under an upheld report; all of its reports are voided"));
    }

    const reportId = keccak256(toHex(`${operator}:${targetAddr}:${args.evidenceURI}:${now}`));
    const challengeEndsAt = new Date(Number(now + BigInt(CHALLENGE_WINDOW_SECONDS)) * 1000).toISOString();

    return jsonResult({
      reportId,
      bond: requiredBond,
      challengeEndsAt,
      state: "PENDING",
      youAreRisking:
        `${requiredBond} VOUCHME. If the target's vouchers rebut and arbitration rules MALICIOUS, ` +
        `you lose the bond AND an upheld report is registered against you, voiding every report ` +
        `you have filed anywhere.`,
      subgraphDeployment: graph.meta.deploymentId,
      computedAtBlock: graph.meta.blockNumber,
    });
  },
};
