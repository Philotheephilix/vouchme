#!/usr/bin/env node
// substreams/scripts/fetch-fixtures.mjs
//
// Fetches REAL Vouched/Revoked/Reaffirmed/Enrolled logs from the deployed AvalRegistry on World
// Chain Sepolia via raw JSON-RPC eth_getLogs (the SAME topic0 hashes aval-trust/src/lib.rs's
// tests use), and writes them to a fixture file.
//
// Why raw JSON-RPC instead of viem's `client.getLogs({ topics })`: an earlier attempt using
// viem's typed client silently ignored the `topics` filter against this specific RPC endpoint and
// returned every log for the address regardless of topic0 (verified by comparing distinct topic0
// values across four supposedly-different queries — all four came back identical). Raw
// `eth_getLogs` with a `topics` array, confirmed via direct `curl`, filters correctly. Node's
// built-in `fetch` is used to stay dependency-free.
//
// Usage: node substreams/scripts/fetch-fixtures.mjs
// (run from the repo root, or anywhere — paths below are absolute via REPO_ROOT)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..") + "/";

process.loadEnvFile(`${REPO_ROOT}contracts/.env`);
const RPC_URL = process.env.WORLDCHAIN_SEPOLIA_RPC;
const deployments = JSON.parse(readFileSync(`${REPO_ROOT}deployments/worldchain-sepolia.json`, "utf8"));
const REGISTRY_ADDRESS = deployments.contracts.AvalRegistry.address;
const DEPLOY_BLOCK = deployments.deploymentBlock;

// topic0 = keccak256(canonical event signature), computed via viem and independently
// cross-checked against real on-chain logs (see ../PROOF.md) — must match
// aval-trust/src/lib.rs's REAL_PARAMS test constant exactly.
export const TOPICS = {
  Vouched:    "0x1023f6bd7654e275f0ff5868480691e3f5feb9960e997af34f0cf9e4b33e22b9",
  Revoked:    "0xb1c57350b08a198ff1a7862eeb3246e35fa3fc8e954bc691997ce37da018cbc7",
  Reaffirmed: "0x9089bae040c16337c6e96ac1661dba8c85c8b076f44d68407b4fa00243c05db7",
  Enrolled:   "0x21f09afe14df68eeb2c0fd22ba443b93b0e63d090521d32444903f1d1277793f",
};

let id = 1;
async function rpc(method, params) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method} failed: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function getLogsFor(topic0) {
  const latestHex = await rpc("eth_blockNumber", []);
  const latest = parseInt(latestHex, 16);
  const CHUNK = 100; // this RPC gateway caps eth_getLogs at a 100-block range per call
  const logs = [];
  for (let from = DEPLOY_BLOCK; from <= latest; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, latest);
    const chunk = await rpc("eth_getLogs", [{
      address: REGISTRY_ADDRESS,
      topics: [topic0],
      fromBlock: "0x" + from.toString(16),
      toBlock: "0x" + to.toString(16),
    }]);
    logs.push(...chunk);
  }
  return logs;
}

export async function fetchAllFixtures() {
  const out = {};
  for (const [name, topic0] of Object.entries(TOPICS)) {
    const logs = await getLogsFor(topic0);
    out[name] = logs.map((l) => ({
      address: l.address,
      topics: l.topics,
      data: l.data,
      blockNumber: parseInt(l.blockNumber, 16),
      blockTimestamp: l.blockTimestamp ? parseInt(l.blockTimestamp, 16) : null,
      txHash: l.transactionHash,
      logIndex: parseInt(l.logIndex, 16),
    }));
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await fetchAllFixtures();
  for (const [name, logs] of Object.entries(out)) {
    console.log(`${name}: ${logs.length} logs (topic0 ${TOPICS[name]})`);
  }
  const outPath = join(__dirname, "..", "aval-trust", "testdata", "worldchain-sepolia-fixtures.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${outPath}`);
}
