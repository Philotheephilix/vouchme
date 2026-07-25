#!/usr/bin/env node
// @vouchme/mcp — src/index.ts
//
// vouchme-mcp: an MCP server over stdio exposing the VouchMe trust graph to
// agents (docs/06-mcp-skills.md). "is there an accountable human behind
// this counterparty, and how sure am I?" becomes one tool call that
// returns a number, a tier, and the derivation.
//
// ── IMPORTANT: there is no `vouchme_vouch` tool, and there never will be. ──
// Vouching requires human presence (`require_user_presence: true` on the
// World ID attestation, docs/03-worldid.md §5). Exposing it here would
// hand an agent the one capability the entire design withholds from it:
// the ability to CREATE trust. This is not an oversight — it is the
// asymmetry the whole protocol rests on (docs/06-mcp-skills.md §3):
// "creating trust requires a present human; withdrawing it does not."
// vouchme_report exists and has real effects; vouchme_vouch does not exist and
// never will. If you are looking for a way to let an agent vouch, stop —
// that is the one thing this server is deliberately incapable of.

import type { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createGraphClientSafe } from "./client.js";
import type { ToolContext, ToolDefinition } from "./tools/types.js";

import { tool as vouchMeResolve } from "./tools/vouchme_resolve.js";
import { tool as vouchMeScore } from "./tools/vouchme_score.js";
import { tool as vouchMeExplain } from "./tools/vouchme_explain.js";
import { tool as vouchMeGate } from "./tools/vouchme_gate.js";
import { tool as vouchMeSimulateVouch } from "./tools/vouchme_simulate_vouch.js";
import { tool as vouchMePath } from "./tools/vouchme_path.js";
import { tool as vouchMeCandidates } from "./tools/vouchme_candidates.js";
import { tool as vouchMeCrossProtocolTrust } from "./tools/vouchme_cross_protocol_trust.js";
import { tool as vouchMeAnchorStatus } from "./tools/vouchme_anchor_status.js";
import { tool as vouchMeHistory } from "./tools/vouchme_history.js";
import { tool as vouchMeRequestScore } from "./tools/vouchme_request_score.js";
import { tool as vouchMeReport } from "./tools/vouchme_report.js";
import { tool as vouchMeReportStatus } from "./tools/vouchme_report_status.js";
import { tool as vouchMePlatform } from "./tools/vouchme_platform.js";
import { tool as vouchMePipelinePreview } from "./tools/vouchme_pipeline_preview.js";
import { tool as vouchMePipelineDeploy } from "./tools/vouchme_pipeline_deploy.js";
import { tool as vouchMeQuery } from "./tools/vouchme_query.js";

function loadToolContext(env: NodeJS.ProcessEnv = process.env): ToolContext {
  // createGraphClientSafe never throws — see its own doc comment in client.ts. The 8 tools wired
  // to live World Chain Sepolia data (vouchme_resolve, vouchme_score, vouchme_explain, vouchme_gate,
  // vouchme_path, vouchme_candidates, vouchme_anchor_status, vouchme_simulate_vouch) never touch this client;
  // the remaining ones that still need a Subgraph refuse with a named GraphClientConfigError the
  // moment they're actually invoked, rather than failing the whole server at startup.
  const client = createGraphClientSafe(env);
  return {
    client,
    operatorAddress: env.VOUCHME_OPERATOR_ADDRESS,
    substreamsApiToken: env.SUBSTREAMS_API_TOKEN,
    substreamsEndpoint: env.SUBSTREAMS_ENDPOINT,
  };
}

/**
 * Registers one tool. A plain generic function (rather than looping over
 * a `ToolDefinition[]` array) so each tool's zod Shape is inferred
 * independently per call — an array of a shared `ToolDefinition<Shape>`
 * type would force every handler's argument type to widen to a common
 * shape, which is unsound (handler parameters are contravariant) once zod
 * is actually installed and its types resolve.
 */
function registerTool<Shape extends z.ZodRawShape>(server: McpServer, t: ToolDefinition<Shape>, ctx: ToolContext): void {
  const callback = async (args: z.objectOutputType<Shape, z.ZodTypeAny>): Promise<CallToolResult> => {
    // Rebuilt as a fresh object literal (rather than returned as-is) so its shape is checked
    // structurally against the SDK's CallToolResult, whose `content` union includes several
    // block types beyond ours: a `ToolResult` value satisfies that shape, but the SDK's
    // `CallToolResult` type also carries an index signature (from its zod `.loose()` schema)
    // that only a fresh literal — not a named `ToolResult`-typed value — satisfies.
    const result = await t.handler(args, ctx);
    return { content: result.content, isError: result.isError };
  };
  // `callback`'s parameter is typed with zod's own `objectOutputType<Shape, ZodTypeAny>`, which is
  // mutually assignable with the SDK's own `ShapeOutput<Shape>` that `server.tool`'s overloads
  // expect — but that equivalence runs through `BaseToolCallback`'s *conditional* type on `Shape`,
  // and TypeScript cannot resolve a conditional type against a still-generic, unresolved type
  // parameter (a known TS limitation, not a real type mismatch — the two sides only diverge in how
  // each is *spelled*, never in what values they admit). This is the single, centralized seam where
  // that's asserted, via `unknown`, so none of the 17 call sites below have to cast.
  server.tool(t.name, t.description, t.inputSchema, callback as unknown as ToolCallback<Shape>);
}

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "vouchme-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

  // 16 tools from docs/06-mcp-skills.md §2, plus vouchme_query, the escape
  // hatch (§2.15) — 17 registrations total. NOT 18: vouchme_vouch is absent
  // by design (see the module comment above).
  registerTool(server, vouchMeResolve, ctx);
  registerTool(server, vouchMeScore, ctx);
  registerTool(server, vouchMeExplain, ctx);
  registerTool(server, vouchMeGate, ctx);
  registerTool(server, vouchMeSimulateVouch, ctx);
  registerTool(server, vouchMePath, ctx);
  registerTool(server, vouchMeCandidates, ctx);
  registerTool(server, vouchMeCrossProtocolTrust, ctx);
  registerTool(server, vouchMeAnchorStatus, ctx);
  registerTool(server, vouchMeHistory, ctx);
  registerTool(server, vouchMeRequestScore, ctx);
  registerTool(server, vouchMeReport, ctx);
  registerTool(server, vouchMeReportStatus, ctx);
  registerTool(server, vouchMePlatform, ctx);
  registerTool(server, vouchMePipelinePreview, ctx);
  registerTool(server, vouchMePipelineDeploy, ctx);
  registerTool(server, vouchMeQuery, ctx);

  return server;
}

async function main(): Promise<void> {
  const ctx = loadToolContext();
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(
    "vouchme-mcp: listening on stdio (17 tools registered; vouchme_vouch intentionally absent; " +
      "trust graph read live from World Chain Sepolia, chainId 4801 — no subgraph deployed)",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("vouchme-mcp: fatal error", err);
    process.exitCode = 1;
  });
}
