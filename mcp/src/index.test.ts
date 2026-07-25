// @vouchme/mcp — src/index.test.ts
//
// Protocol-level smoke test: spawns the actual compiled server as a child
// process and drives it exactly the way a real MCP client would — an
// `initialize` handshake followed by `tools/list`, both over stdio — via
// the SDK's own Client/StdioClientTransport, rather than unit-testing
// createServer() in-process. Confirms the module comment at the top of
// index.ts is actually true of the running server: exactly 17 tools
// registered, and `vouchme_vouch` never among them (docs/06-mcp-skills.md §3:
// "creating trust requires a present human; withdrawing it does not").
//
// Run with `npm test` after `npm run build` (node's built-in test runner).

import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Sibling of this compiled test file in dist/ — the same entry point
// package.json's `bin.vouchme-mcp` points at.
const SERVER_ENTRY = path.join(__dirname, "index.js");

// Enough config for the server to construct its GraphClient at startup
// (see loadToolContext / loadGraphClientConfigFromEnv in client.ts) without
// making any real subgraph query — `initialize` and `tools/list` are both
// answered from the in-memory tool registry and never touch the network.
const TEST_ENV = {
  VOUCHME_SUBGRAPH_ID: "test-subgraph-id",
  GRAPH_API_KEY: "test-key",
};

const EXPECTED_TOOL_COUNT = 17;

test("initialize + tools/list over stdio: exactly 17 tools, vouchme_vouch absent", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: TEST_ENV,
    stderr: "ignore",
  });
  const client = new Client({ name: "vouchme-mcp-test-client", version: "0.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport); // performs the `initialize` handshake over stdio

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    assert.equal(tools.length, EXPECTED_TOOL_COUNT, `expected exactly ${EXPECTED_TOOL_COUNT} tools, got: ${names.join(", ")}`);
    assert.ok(!names.includes("vouchme_vouch"), "vouchme_vouch must never be registered — vouching requires human presence");

    // Every documented tool name (docs/06-mcp-skills.md §2, mcp/README.md's
    // "The 17 tools" list) is present — catches a silently-dropped
    // registration even if the *count* happened to still be 17.
    const expectedNames = [
      "vouchme_resolve",
      "vouchme_score",
      "vouchme_explain",
      "vouchme_gate",
      "vouchme_simulate_vouch",
      "vouchme_path",
      "vouchme_candidates",
      "vouchme_cross_protocol_trust",
      "vouchme_anchor_status",
      "vouchme_history",
      "vouchme_request_score",
      "vouchme_report",
      "vouchme_report_status",
      "vouchme_platform",
      "vouchme_pipeline_preview",
      "vouchme_pipeline_deploy",
      "vouchme_query",
    ];
    assert.deepEqual([...names].sort(), [...expectedNames].sort());
  } finally {
    await client.close();
  }
});
