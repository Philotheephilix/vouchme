import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.join(__dirname, "dist", "index.js");

const CAROL = "0x23761b08eD8Cd51f43de13CB97F691be7D28ed59";
const RING1 = "0x125314ef90fb942740aa83748137450C8Db0B5C2";

async function main() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER_ENTRY], env: {}, stderr: "inherit" });
  const client = new Client({ name: "verify-client", version: "0.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`Registered tools (${tools.length}):`, tools.map((t) => t.name).sort().join(", "));
  console.log(`aval_vouch present: ${tools.some((t) => t.name === "aval_vouch")}\n`);

  console.log(`=== aval_score(${CAROL}) — carol ===`);
  const carolScore = await client.callTool({ name: "aval_score", arguments: { address: CAROL } }, undefined, { timeout: 180_000 });
  console.log(carolScore.content[0].text);

  console.log(`\n=== aval_score(${RING1}) — ring1 ===`);
  const ringScore = await client.callTool({ name: "aval_score", arguments: { address: RING1 } }, undefined, { timeout: 180_000 });
  console.log(ringScore.content[0].text);

  console.log(`\n=== aval_gate(${RING1}, {minTier:1}) — ring1 ===`);
  const gate = await client.callTool({ name: "aval_gate", arguments: { address: RING1, policy: { minTier: 1 } } }, undefined, { timeout: 180_000 });
  console.log(gate.content[0].text);

  console.log(`\n=== aval_resolve(${CAROL}) — carol ===`);
  const resolve = await client.callTool({ name: "aval_resolve", arguments: { identifier: CAROL } }, undefined, { timeout: 180_000 });
  console.log(resolve.content[0].text);

  console.log(`\n=== aval_anchor_status(${CAROL}) — carol (not an anchor) ===`);
  const anchorStatus = await client.callTool({ name: "aval_anchor_status", arguments: { address: CAROL } }, undefined, { timeout: 180_000 });
  console.log(anchorStatus.content[0].text);

  await client.close();
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exitCode = 1;
});
