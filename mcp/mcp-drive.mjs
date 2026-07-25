import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const CAROL = "0x23761b08eD8Cd51f43de13CB97F691be7D28ed59";
const RING1 = "0x125314ef90fb942740aa83748137450C8Db0B5C2";

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: {},
  stderr: "inherit",
});
const client = new Client({ name: "verify-client", version: "0.0.0" }, { capabilities: {} });
await client.connect(transport);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 180000 });
  const text = res.content?.[0]?.text ?? "";
  console.log(`\n=== ${name}(${JSON.stringify(args)}) ===`);
  console.log(text);
  return { res, parsed: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

await call("aval_score", { address: CAROL });
await call("aval_score", { address: RING1 });
await call("aval_gate", { address: RING1, policy: { minTier: 1 } });

await client.close();
