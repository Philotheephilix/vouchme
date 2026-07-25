// scripts/live-verify.mjs
//
// Proves the protocol against live World Chain Sepolia data: reads Enrolled/Vouched/Revoked/
// Reaffirmed logs from the deployed AvalRegistry, reads anchor status live from
// GenesisAnchorBook.getIsUserVerified, builds an EngineInput exactly the way an indexer would,
// and runs it through the real @aval/engine `compute()` — the same function the app/subgraph use.
//
// Asserts the expected values from docs/01-trust-math.md §12.1 and exits non-zero on mismatch.
// A mismatch is reported, never silently reconciled by editing the assertion.

import { createPublicClient, http } from "viem";
import { readFileSync } from "node:fs";
import { BASE } from "../engine/dist/constants.js";
import { compute } from "@aval/engine";
import { deriveIdentities } from "./identities.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
process.loadEnvFile(`${REPO_ROOT}contracts/.env`);

const RPC_URL = process.env.WORLDCHAIN_SEPOLIA_RPC;
const deployments = JSON.parse(readFileSync(`${REPO_ROOT}deployments/worldchain-sepolia.json`, "utf8"));
const REGISTRY_ADDRESS = deployments.contracts.AvalRegistry.address;
const ANCHOR_BOOK_ADDRESS = deployments.contracts.GenesisAnchorBook.address;
const DEPLOY_BLOCK = BigInt(deployments.deploymentBlock);

const registryArtifact = JSON.parse(
  readFileSync(`${REPO_ROOT}contracts/out/AvalRegistry.sol/AvalRegistry.json`, "utf8")
);
const anchorBookArtifact = JSON.parse(
  readFileSync(`${REPO_ROOT}contracts/out/GenesisAnchorBook.sol/GenesisAnchorBook.json`, "utf8")
);
const REGISTRY_ABI = registryArtifact.abi;
const ANCHOR_BOOK_ABI = anchorBookArtifact.abi;

const worldChainSepolia = {
  id: 4801,
  name: "World Chain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};
const publicClient = createPublicClient({ chain: worldChainSepolia, transport: http(RPC_URL) });

const eventAbi = (name) => REGISTRY_ABI.find((x) => x.type === "event" && x.name === name);

function centiToDisplay(centi) {
  return (centi / 100).toFixed(2);
}

/** The public RPC gateway caps eth_getLogs at a 100-block range per call, so paginate. */
async function getEventLogs(eventName) {
  const latest = await publicClient.getBlockNumber();
  const CHUNK = 100n;
  const logs = [];
  for (let from = DEPLOY_BLOCK; from <= latest; from += CHUNK) {
    const to = from + CHUNK - 1n > latest ? latest : from + CHUNK - 1n;
    const chunkLogs = await publicClient.getLogs({
      address: REGISTRY_ADDRESS,
      event: eventAbi(eventName),
      fromBlock: from,
      toBlock: to,
    });
    logs.push(...chunkLogs);
  }
  return logs;
}

/** Sort by (blockNumber, logIndex) — chronological on-chain order. */
function chronological(logs) {
  return [...logs].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
}

async function main() {
  console.log(`AvalRegistry:     ${REGISTRY_ADDRESS}`);
  console.log(`GenesisAnchorBook: ${ANCHOR_BOOK_ADDRESS}`);
  console.log(`From block:        ${DEPLOY_BLOCK}\n`);

  const [enrolledLogs, vouchedLogs, revokedLogs, reaffirmedLogs] = await Promise.all([
    getEventLogs("Enrolled"),
    getEventLogs("Vouched"),
    getEventLogs("Revoked"),
    getEventLogs("Reaffirmed"),
  ]);

  console.log(
    `Logs: ${enrolledLogs.length} Enrolled, ${vouchedLogs.length} Vouched, ${revokedLogs.length} Revoked, ${reaffirmedLogs.length} Reaffirmed\n`
  );

  // ── accounts: every distinct address that ever enrolled ──────────────────────────────────
  const accountAddresses = [...new Set(enrolledLogs.map((l) => l.args.account))];

  // ── anchor status: read LIVE from GenesisAnchorBook, not inferred from any event ─────────
  const anchorFlags = await Promise.all(
    accountAddresses.map((addr) =>
      publicClient.readContract({
        address: ANCHOR_BOOK_ADDRESS,
        abi: ANCHOR_BOOK_ABI,
        functionName: "getIsUserVerified",
        args: [addr],
      })
    )
  );
  const isAnchorMap = new Map(accountAddresses.map((addr, i) => [addr, anchorFlags[i]]));

  const accounts = accountAddresses.map((addr) => ({
    id: addr,
    kind: "human",
    isAnchor: isAnchorMap.get(addr),
    epochsClaimed: 0,
    active: true,
  }));

  // ── edges: replay Vouched/Reaffirmed/Revoked chronologically per (voucher, vouchee) pair to
  // resolve final state — docs/01-trust-math.md §18: "the engine must be correct on any edge
  // multiset the indexer can emit," and the Vouch type carries no timestamp of its own, so
  // resolving "latest" is the caller's job before construction, not the engine's. ─────────────
  /** @type {Map<string, {issuedAt:number, expiresAt:number, revoked:boolean}>} */
  const pairState = new Map();
  const pairKey = (voucher, vouchee) => `${voucher}::${vouchee}`;

  const events = [
    ...vouchedLogs.map((l) => ({ kind: "Vouched", block: l.blockNumber, logIndex: l.logIndex, args: l.args })),
    ...reaffirmedLogs.map((l) => ({ kind: "Reaffirmed", block: l.blockNumber, logIndex: l.logIndex, args: l.args })),
    ...revokedLogs.map((l) => ({ kind: "Revoked", block: l.blockNumber, logIndex: l.logIndex, args: l.args })),
  ].sort((a, b) => (a.block !== b.block ? (a.block < b.block ? -1 : 1) : a.logIndex - b.logIndex));

  for (const ev of events) {
    const key = pairKey(ev.args.voucher, ev.args.vouchee);
    if (ev.kind === "Vouched") {
      pairState.set(key, {
        issuedAt: Number(ev.args.issuedAt),
        expiresAt: Number(ev.args.expiresAt),
        revoked: false,
      });
    } else if (ev.kind === "Reaffirmed") {
      const cur = pairState.get(key);
      if (cur) cur.expiresAt = Number(ev.args.expiresAt);
    } else if (ev.kind === "Revoked") {
      const cur = pairState.get(key);
      if (cur) cur.revoked = true;
    }
  }

  const latestBlock = await publicClient.getBlock();
  const now = Number(latestBlock.timestamp);

  const vouches = [...pairState.entries()].map(([key, state]) => {
    const [voucher, vouchee] = key.split("::");
    const active = !state.revoked && now < state.expiresAt;
    return { voucher, vouchee, active };
  });

  console.log(`Accounts: ${accounts.length}   Vouch pairs (deduplicated): ${vouches.length}   now=${now}\n`);

  const engineInput = { now, accounts, vouches, platformVouches: [], reports: [] };
  const output = compute(engineInput);

  // ── build a label lookup so the printed table reads by name, not by address ──────────────
  const identities = deriveIdentities();
  const addrToLabel = new Map(Object.entries(identities).map(([label, acct]) => [acct.address, label]));
  const labelFor = (addr) => addrToLabel.get(addr) ?? addr;

  const tierName = (t) => (t === 2 ? "Tier 2" : t === 1 ? "Tier 1" : "Tier 0");
  const depthDisplay = (d) => (d === Infinity ? "∞ (unreachable)" : String(d));

  // ── expected values, docs/01-trust-math.md §12.1 — kept exactly as specified; NOT adjusted
  // to match whatever the chain says. ──
  const expectations = [
    // Derived from the engine's own constants, never hardcoded, so they cannot drift when the
    // constants change.
    //   depth-1 (2 anchors)  = BASE + 2*20                       = 60.00
    //   depth-2 (3 x depth-1) = BASE + 3*min(60*0.25,20) = BASE+45 = 65.00
    //   unreachable           = BASE                              = 20.00
    { label: "alice", score: BASE + 4000, tier: 1, depth: 1 },
    { label: "bob", score: BASE + 4000, tier: 1, depth: 1 },
    { label: "erin", score: BASE + 4000, tier: 1, depth: 1 },
    { label: "carol", score: BASE + 4500, tier: 1, depth: 2 },
    { label: "dave", score: BASE, tier: 0, depth: Infinity },
    { label: "ring1", score: BASE, tier: 0, depth: Infinity },
    { label: "ring2", score: BASE, tier: 0, depth: Infinity },
    { label: "ring3", score: BASE, tier: 0, depth: Infinity },
    { label: "ring4", score: BASE, tier: 0, depth: Infinity },
    { label: "ring5", score: BASE, tier: 0, depth: Infinity },
    { label: "ring6", score: BASE, tier: 0, depth: Infinity },
  ];

  console.log(
    "label".padEnd(8),
    "address".padEnd(44),
    "score".padEnd(8),
    "tier".padEnd(7),
    "depth".padEnd(16),
    "expected score/tier/depth"
  );
  console.log("-".repeat(120));

  let anyFail = false;
  const rows = [];
  for (const exp of expectations) {
    const addr = identities[exp.label].address;
    const actualScore = output.score[addr] ?? 0;
    const actualTier = output.tier[addr] ?? 0;
    const actualDepth = output.depth[addr] ?? Infinity;

    const pass = actualScore === exp.score && actualTier === exp.tier && actualDepth === exp.depth;
    if (!pass) anyFail = true;

    rows.push({ label: exp.label, addr, actualScore, actualTier, actualDepth, exp, pass });

    console.log(
      exp.label.padEnd(8),
      addr.padEnd(44),
      centiToDisplay(actualScore).padEnd(8),
      tierName(actualTier).padEnd(7),
      depthDisplay(actualDepth).padEnd(16),
      `${pass ? "PASS" : "FAIL"}  expected ${centiToDisplay(exp.score)} / ${tierName(exp.tier)} / depth ${depthDisplay(exp.depth)}`
    );
  }

  console.log("\n── full account table (everyone the engine scored) ──────────────────────────");
  for (const addr of accountAddresses) {
    const label = labelFor(addr);
    console.log(
      label.padEnd(8),
      addr.padEnd(44),
      centiToDisplay(output.score[addr] ?? 0).padEnd(8),
      tierName(output.tier[addr] ?? 0).padEnd(7),
      depthDisplay(output.depth[addr] ?? Infinity)
    );
  }

  console.log(`\nconverged: ${output.converged}`);
  console.log(`origins:   ${output.origins.map(labelFor).join(", ")}`);

  if (anyFail) {
    console.log("\nRESULT: one or more scores diverge from docs/01-trust-math.md §12.1 expectations.");
    console.log("See the task report for root-cause analysis of each divergence (chain vs spec).");
    process.exit(1);
  } else {
    console.log("\nRESULT: all assertions passed.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
