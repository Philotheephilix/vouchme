// @aval/mcp — src/index.test.ts
//
// Protocol-level smoke test: spawns the actual compiled server as a child
// process and drives it exactly the way a real MCP client would — an
// `initialize` handshake followed by `tools/list`, both over stdio — via
// the SDK's own Client/StdioClientTransport, rather than unit-testing
// createServer() in-process. Confirms the module comment at the top of
// index.ts is actually true of the running server: exactly 17 tools
// registered, and `aval_vouch` never among them (docs/06-mcp-skills.md §3:
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
// package.json's `bin.aval-mcp` points at.
const SERVER_ENTRY = path.join(__dirname, "index.js");

// Enough config for the server to construct its GraphClient at startup
// (see loadToolContext / loadGraphClientConfigFromEnv in client.ts) without
// making any real subgraph query — `initialize` and `tools/list` are both
// answered from the in-memory tool registry and never touch the network.
const TEST_ENV = {
  AVAL_SUBGRAPH_ID: "test-subgraph-id",
  GRAPH_API_KEY: "test-key",
};

const EXPECTED_TOOL_COUNT = 17;

test("initialize + tools/list over stdio: exactly 17 tools, aval_vouch absent", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: TEST_ENV,
    stderr: "ignore",
  });
  const client = new Client({ name: "aval-mcp-test-client", version: "0.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport); // performs the `initialize` handshake over stdio

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);

    assert.equal(tools.length, EXPECTED_TOOL_COUNT, `expected exactly ${EXPECTED_TOOL_COUNT} tools, got: ${names.join(", ")}`);
    assert.ok(!names.includes("aval_vouch"), "aval_vouch must never be registered — vouching requires human presence");

    // Every documented tool name (docs/06-mcp-skills.md §2, mcp/README.md's
    // "The 17 tools" list) is present — catches a silently-dropped
    // registration even if the *count* happened to still be 17.
    const expectedNames = [
      "aval_resolve",
      "aval_score",
      "aval_explain",
      "aval_gate",
      "aval_simulate_vouch",
      "aval_path",
      "aval_candidates",
      "aval_cross_protocol_trust",
      "aval_anchor_status",
      "aval_history",
      "aval_request_score",
      "aval_report",
      "aval_report_status",
      "aval_platform",
      "aval_pipeline_preview",
      "aval_pipeline_deploy",
      "aval_query",
    ];
    assert.deepEqual([...names].sort(), [...expectedNames].sort());
  } finally {
    await client.close();
  }
});
