#!/usr/bin/env node
// @aval/mcp — src/index.ts
//
// aval-mcp: an MCP server over stdio exposing the Aval trust graph to
// agents (docs/06-mcp-skills.md). "is there an accountable human behind
// this counterparty, and how sure am I?" becomes one tool call that
// returns a number, a tier, and the derivation.
//
// ── IMPORTANT: there is no `aval_vouch` tool, and there never will be. ──
// Vouching requires human presence (`require_user_presence: true` on the
// World ID attestation, docs/03-worldid.md §5). Exposing it here would
// hand an agent the one capability the entire design withholds from it:
// the ability to CREATE trust. This is not an oversight — it is the
// asymmetry the whole protocol rests on (docs/06-mcp-skills.md §3):
// "creating trust requires a present human; withdrawing it does not."
// aval_report exists and has real effects; aval_vouch does not exist and
// never will. If you are looking for a way to let an agent vouch, stop —
// that is the one thing this server is deliberately incapable of.

import type { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createGraphClientSafe } from "./client.js";
import type { ToolContext, ToolDefinition } from "./tools/types.js";

import { tool as avalResolve } from "./tools/aval_resolve.js";
import { tool as avalScore } from "./tools/aval_score.js";
import { tool as avalExplain } from "./tools/aval_explain.js";
import { tool as avalGate } from "./tools/aval_gate.js";
import { tool as avalSimulateVouch } from "./tools/aval_simulate_vouch.js";
import { tool as avalPath } from "./tools/aval_path.js";
import { tool as avalCandidates } from "./tools/aval_candidates.js";
import { tool as avalCrossProtocolTrust } from "./tools/aval_cross_protocol_trust.js";
import { tool as avalAnchorStatus } from "./tools/aval_anchor_status.js";
import { tool as avalHistory } from "./tools/aval_history.js";
import { tool as avalRequestScore } from "./tools/aval_request_score.js";
import { tool as avalReport } from "./tools/aval_report.js";
import { tool as avalReportStatus } from "./tools/aval_report_status.js";
import { tool as avalPlatform } from "./tools/aval_platform.js";
import { tool as avalPipelinePreview } from "./tools/aval_pipeline_preview.js";
import { tool as avalPipelineDeploy } from "./tools/aval_pipeline_deploy.js";
import { tool as avalQuery } from "./tools/aval_query.js";

function loadToolContext(env: NodeJS.ProcessEnv = process.env): ToolContext {
  // createGraphClientSafe never throws — see its own doc comment in client.ts. The 8 tools wired
  // to live World Chain Sepolia data (aval_resolve, aval_score, aval_explain, aval_gate,
  // aval_path, aval_candidates, aval_anchor_status, aval_simulate_vouch) never touch this client;
  // the remaining ones that still need a Subgraph refuse with a named GraphClientConfigError the
  // moment they're actually invoked, rather than failing the whole server at startup.
  const client = createGraphClientSafe(env);
  return {
    client,
    operatorAddress: env.AVAL_OPERATOR_ADDRESS,
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
  // `callback`'s parameter is typed with zod's own `objectOutputType<Shape, ZodTypeAny>`, which
  // is provably (and has been verified directly, for every concrete Shape) mutually assignable
  // with the SDK's own `ShapeOutput<Shape>` that `server.tool`'s overloads expect — but that
  // equivalence runs through `BaseToolCallback`'s *conditional* type on `Shape`, and TypeScript
  // cannot resolve a conditional type against a still-generic, unresolved type parameter (a known
  // TS limitation, not a real type mismatch — the two sides only diverge in how each is *spelled*,
  // never in what values they admit). This is the single, centralized seam where that's asserted,
  // via `unknown` per the compiler's own suggested escape hatch, so none of the 17 call sites below
  // have to cast.
  server.tool(t.name, t.description, t.inputSchema, callback as unknown as ToolCallback<Shape>);
}

export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "aval-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

  // 16 tools from docs/06-mcp-skills.md §2, plus aval_query, the escape
  // hatch (§2.15) — 17 registrations total. NOT 18: aval_vouch is absent
  // by design (see the module comment above).
  registerTool(server, avalResolve, ctx);
  registerTool(server, avalScore, ctx);
  registerTool(server, avalExplain, ctx);
  registerTool(server, avalGate, ctx);
  registerTool(server, avalSimulateVouch, ctx);
  registerTool(server, avalPath, ctx);
  registerTool(server, avalCandidates, ctx);
  registerTool(server, avalCrossProtocolTrust, ctx);
  registerTool(server, avalAnchorStatus, ctx);
  registerTool(server, avalHistory, ctx);
  registerTool(server, avalRequestScore, ctx);
  registerTool(server, avalReport, ctx);
  registerTool(server, avalReportStatus, ctx);
  registerTool(server, avalPlatform, ctx);
  registerTool(server, avalPipelinePreview, ctx);
  registerTool(server, avalPipelineDeploy, ctx);
  registerTool(server, avalQuery, ctx);

  return server;
}

async function main(): Promise<void> {
  const ctx = loadToolContext();
  const server = createServer(ctx);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // eslint-disable-next-line no-console
  console.error(
    "aval-mcp: listening on stdio (17 tools registered; aval_vouch intentionally absent; " +
      "trust graph read live from World Chain Sepolia, chainId 4801 — no subgraph deployed)",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error("aval-mcp: fatal error", err);
    process.exitCode = 1;
  });
}
