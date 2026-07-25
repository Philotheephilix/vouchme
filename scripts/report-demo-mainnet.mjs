// scripts/report-demo-mainnet.mjs
//
// Files a REAL report on World Chain mainnet (480) against the live ReportRegistry
// 0x4570b517c75a90F85C9fED321113Fb80FC777bCc, and prints the before/after engine output read from
// the same chain.
//
// ── Constraints this script runs under ──────────────────────────────────────────────────────────
//
// 1. **The demo accounts are not people.** `reportdemo-a/b/target` are keys derived from the public
//    seed in scripts/identities.mjs. They enroll with an attestation this repo's attestor key signs
//    for itself and a nullifier derived from a printed string — NOT a World ID nullifier, because
//    no World ID proof exists for them. They are therefore NOT Orb-verified, which is the point:
//    they are the only kind of account on this chain whose score is computed rather than fixed
//    at 100.
//
// 2. **The reporter is tier 0, and docs/12-reporting.md §2 says a reporter must be tier ≥ 1.**
//    `app/src/app/api/report/attest` enforces that rule and refuses these accounts — run
//    `--check-route` to see it refuse. This script signs the same EIP-712 attestation directly,
//    with the honest weight (`weightNeg(score)`, the exact number the engine will re-derive), and
//    that single policy check is the only thing it skips. It CANNOT be satisfied here: tier ≥ 1
//    needs two vouches from accounts closer to an anchor, the only anchors on chain 480 are World
//    ID Orb accounts, and the only two enrolled Orb accounts (philoo, romariokavin) are World App
//    smart-contract wallets whose keys are not in this repo.
//
// 3. **No score can move on this chain.** A non-anchor with no anchor vouch has s⁺ = base exactly,
//    and `score = max(base + tenure, s⁺ − Σd)`, so the floor is already where the score is. The
//    report is real and valid and carries real weight, but the target's score is unchanged by it.
//
// Usage:
//   node scripts/report-demo-mainnet.mjs --wire        governor: setAttestor + setMinter
//   node scripts/report-demo-mainnet.mjs --fund        governor: gas + VOUCHME bonds for the demo accounts
//   node scripts/report-demo-mainnet.mjs --enroll      enroll the three demo accounts
//   node scripts/report-demo-mainnet.mjs --file        file the report (reportdemo-a -> reportdemo-target)
//   node scripts/report-demo-mainnet.mjs --file-b      file a second one (reportdemo-b -> target)
//   node scripts/report-demo-mainnet.mjs --withdraw-b  withdraw it, to exercise the WITHDRAWN verdict
//   node scripts/report-demo-mainnet.mjs --state       read everything back, run the engine, print it

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  fallback,
  encodeAbiParameters,
  formatEther,
  getAddress,
  http,
  keccak256,
  parseAbiItem,
  toBytes,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { compute, weightNeg } from "@vouchme/engine";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readEnvFile(p) {
  const out = {};
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    if (!line.includes("=") || line.trim().startsWith("#")) continue;
    const i = line.indexOf("=");
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const appEnv = readEnvFile(path.join(ROOT, "app/.env.local"));
const contractsEnv = readEnvFile(path.join(ROOT, "contracts/.env"));

const RPC_URLS = [
  appEnv.NEXT_PUBLIC_WORLDCHAIN_RPC,
  appEnv.NEXT_PUBLIC_WORLDCHAIN_RPC_FALLBACK,
  "https://worldchain-mainnet.g.alchemy.com/public",
].filter(Boolean);

const CHAIN = {
  id: 480,
  name: "World Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
};

// Deployment facts, copied from deployments/worldchain-mainnet.json and re-checksummed (that file
// stores ReportRegistry with a mis-typed EIP-55 capitalisation; the bytes are right).
const ADDR = {
  vouchMeRegistry: getAddress("0x6fEfEf2d44203300a6a33d631840C972181b8722".toLowerCase()),
  reportRegistry: getAddress("0x4570B517C75A90F85c9FeD321113fB80FC777bcC".toLowerCase()),
  platformRegistry: getAddress("0xbBEE544679F9C5a8784F30195a9030131f9E9106".toLowerCase()),
  vault: getAddress("0xE3bb69E90d124268A348A3ef17420d05CF6e177D".toLowerCase()),
  token: getAddress("0xdF0cdF53981bdbcCF25cC0d51E8948579adA82Ef".toLowerCase()),
  presenceDrip: getAddress("0x4C0cf0D239A1012D432EDEa47e3BB1cb00F5192d".toLowerCase()),
  addressBook: getAddress("0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D".toLowerCase()),
};
const DEPLOY_BLOCK = 32833177n;

const governor = privateKeyToAccount(contractsEnv.PRIVATE_KEY);
const attestor = privateKeyToAccount(appEnv.ATTESTOR_PRIVATE_KEY);

// ── demo identities ─────────────────────────────────────────────────────────────────────────────
// Same public, non-secret derivation as scripts/identities.mjs, with mainnet-specific labels so
// these keys are reproducible by anyone reading the repo and are obviously throwaway.
const DEMO_SEED = "vouchme/worldchain-mainnet/report-demo/v1";
const demoKey = (label) => keccak256(toBytes(`${DEMO_SEED}::${label}`));
const DEMO = {
  reporterA: privateKeyToAccount(demoKey("reportdemo-a")),
  reporterB: privateKeyToAccount(demoKey("reportdemo-b")),
  target: privateKeyToAccount(demoKey("reportdemo-target")),
};
const HANDLES = {
  reporterA: "reportdemo-a.vouchme.eth",
  reporterB: "reportdemo-b.vouchme.eth",
  target: "reportdemo-target.vouchme.eth",
};
/** NOT a World ID nullifier. No World ID proof exists for these accounts; this is a derived,
 *  clearly-labelled placeholder so `usedNullifier` stays one-account-per-value, and it is the one
 *  thing about these enrollments that a real user's enrollment would not have. */
const demoNullifier = (label) => BigInt(keccak256(toBytes(`${DEMO_SEED}::nullifier::${label}`)));

const CRED_SELFIE = keccak256(toBytes("selfie-check"));

// Every configured endpoint, in order, with retries: the public drpc endpoint rate-limits under
// the burst of reads this script issues, and a throttled provider must be routed around rather
// than mistaken for a broken chain.
const transport = fallback(
  RPC_URLS.map((u) => http(u, { retryCount: 4, retryDelay: 800 })),
  { rank: false, retryCount: 2 },
);
const publicClient = createPublicClient({ chain: CHAIN, transport });
const wallet = (account) => createWalletClient({ account, chain: CHAIN, transport });

const abi = {
  setAttestor: parseAbiItem("function setAttestor(address attestor, bool enabled)"),
  setMinter: parseAbiItem("function setMinter(address minter, bool enabled)"),
  mint: parseAbiItem("function mint(address to, uint256 amount)"),
  approve: parseAbiItem("function approve(address spender, uint256 amount) returns (bool)"),
  bondFor: parseAbiItem("function bondFor(address account, uint128 amount)"),
  enroll: parseAbiItem(
    "function enroll(uint256 nullifierHash, bytes32 credential, string handle, uint64 deadline, uint256 nonce, bytes attestation)",
  ),
  file: parseAbiItem(
    "function file(address target, bytes32 evidenceHash, uint32 weightPoints, uint64 deadline, uint256 nonce, bytes attestation) returns (bytes32)",
  ),
  withdrawReport: parseAbiItem("function withdrawReport(bytes32 id)"),
  reports: parseAbiItem(
    "function reports(bytes32) view returns (address reporter, address target, bytes32 evidenceHash, uint32 weightPoints, uint128 bond, uint64 filedAt, uint64 resolvedAt, uint128 rebuttalTotal, uint8 rebutterCount, uint8 state)",
  ),
  attestors: parseAbiItem("function attestors(address) view returns (bool)"),
  minters: parseAbiItem("function minters(address) view returns (bool)"),
  positions: parseAbiItem(
    "function positions(address) view returns (uint128 bonded, uint128 locked, uint128 pendingUnbond, uint64 unbondAt, uint64 lastDemurrage)",
  ),
  members: parseAbiItem(
    "function members(address) view returns (uint64 enrolledAt, uint64 credentialExpiresAt, uint32 activeOutbound, uint64 lastVouchAt, uint64 slotPenaltyUntil, uint8 slotPenaltyCount, bool enrolled, bool fraudulent)",
  ),
  addressVerifiedUntil: parseAbiItem("function addressVerifiedUntil(address) view returns (uint256)"),
  presence: parseAbiItem("function presence(address) view returns (uint64 lastClaimAt, uint64 epochsClaimed, uint64 accrualPausedUntil)"),
  balanceOf: parseAbiItem("function balanceOf(address) view returns (uint256)"),
};

const read = (address, item, functionName, args = []) =>
  publicClient.readContract({ address, abi: [item], functionName, args });

async function send(account, address, item, functionName, args) {
  const { request } = await publicClient.simulateContract({ account, address, abi: [item], functionName, args });
  const hash = await wallet(account).writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`   tx ${hash}  block ${receipt.blockNumber}  status ${receipt.status}  gas ${receipt.gasUsed}`);
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  return receipt;
}

const EIP712 = {
  enrollDomain: { name: "VouchMeRegistry", version: "1", chainId: 480, verifyingContract: ADDR.vouchMeRegistry },
  reportDomain: { name: "ReportRegistry", version: "1", chainId: 480, verifyingContract: ADDR.reportRegistry },
};

const signEnroll = (message) =>
  attestor.signTypedData({
    domain: EIP712.enrollDomain,
    types: {
      EnrollAttestation: [
        { name: "account", type: "address" },
        { name: "nullifierHash", type: "uint256" },
        { name: "credential", type: "bytes32" },
        { name: "deadline", type: "uint64" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "EnrollAttestation",
    message,
  });

const signReport = (message) =>
  attestor.signTypedData({
    domain: EIP712.reportDomain,
    types: {
      ReportAttestation: [
        { name: "reporter", type: "address" },
        { name: "target", type: "address" },
        { name: "weightPoints", type: "uint32" },
        { name: "deadline", type: "uint64" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "ReportAttestation",
    message,
  });

const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const randNonce = () => BigInt(keccak256(toBytes(`${Date.now()}:${Math.random()}`)));

// ── the same graph the app builds, assembled here from the same chain ───────────────────────────
const STATE_NAMES = ["NONE", "PENDING", "ARBITRATION", "UPHELD", "UNPROVEN", "MALICIOUS", "WITHDRAWN"];

async function buildEngineInput() {
  const toBlock = await publicClient.getBlockNumber();
  const block = await publicClient.getBlock({ blockNumber: toBlock });
  const now = Number(block.timestamp);

  const logs = async (address, sig) => {
    const out = [];
    for (let f = DEPLOY_BLOCK; f <= toBlock; ) {
      const t = f + 9999n > toBlock ? toBlock : f + 9999n;
      out.push(...(await publicClient.getLogs({ address, event: parseAbiItem(sig), fromBlock: f, toBlock: t })));
      f = t + 1n;
    }
    return out;
  };

  const enrolled = await logs(
    ADDR.vouchMeRegistry,
    "event Enrolled(address indexed account, uint256 indexed nullifierHash, bytes32 credential, uint64 credentialExpiresAt, string handle)",
  );
  const vouchedLogs = await logs(
    ADDR.vouchMeRegistry,
    "event Vouched(address indexed voucher, address indexed vouchee, uint64 issuedAt, uint64 expiresAt)",
  );
  const revokedLogs = await logs(ADDR.vouchMeRegistry, "event Revoked(address indexed voucher, address indexed vouchee, uint64 at)");
  const filedLogs = await logs(
    ADDR.reportRegistry,
    "event ReportFiled(bytes32 indexed id, address indexed reporter, address indexed target, uint32 weightPoints, uint128 bond, bytes32 evidenceHash)",
  );

  const handles = new Map();
  for (const l of enrolled) handles.set(l.args.account, l.args.handle);
  const addresses = [...handles.keys()];

  const accounts = [];
  for (const a of addresses) {
    const until = await read(ADDR.addressBook, abi.addressVerifiedUntil, "addressVerifiedUntil", [a]);
    const p = await read(ADDR.presenceDrip, abi.presence, "presence", [a]);
    accounts.push({ id: a, kind: "human", isAnchor: until > BigInt(now), epochsClaimed: Number(p[1]), active: true });
  }

  const revoked = new Set(revokedLogs.map((l) => `${l.args.voucher}::${l.args.vouchee}`));
  const vouches = vouchedLogs.map((l) => ({
    voucher: l.args.voucher,
    vouchee: l.args.vouchee,
    active: !revoked.has(`${l.args.voucher}::${l.args.vouchee}`) && now < Number(l.args.expiresAt),
  }));

  const reports = [];
  const rawReports = [];
  for (const l of filedLogs) {
    const r = await read(ADDR.reportRegistry, abi.reports, "reports", [l.args.id]);
    const stateName = STATE_NAMES[Number(r[9])];
    rawReports.push({ id: l.args.id, tx: l.transactionHash, stateName, raw: r });
    const state =
      stateName === "PENDING" || stateName === "ARBITRATION"
        ? "pending"
        : stateName === "UPHELD"
          ? "upheld"
          : stateName === "WITHDRAWN"
            ? "withdrawn"
            : "rejected";
    const rep = { id: l.args.id.toLowerCase(), reporter: r[0], target: r[1], state, snapshotWeight: Number(r[3]) };
    if (state === "upheld") rep.upheldAt = Number(r[6]);
    reports.push(rep);
  }

  return { input: { now, accounts, vouches, platformVouches: [], reports }, handles, rawReports, block: toBlock };
}

function printState({ input, handles, rawReports, block }) {
  const out = compute(input);
  console.log(`\n── engine output at block ${block} (chain time ${new Date(input.now * 1000).toISOString()}) ──`);
  for (const a of input.accounts) {
    console.log(
      `   ${(handles.get(a.id) ?? a.id).padEnd(28)} ${a.id}  anchor=${a.isAnchor ? "yes" : "no "}  ` +
        `s+=${(out.sPlus[a.id] / 100).toFixed(2).padStart(7)}  score=${(out.score[a.id] / 100).toFixed(2).padStart(7)}  ` +
        `atRisk=${(out.scoreAtRisk[a.id] / 100).toFixed(2).padStart(7)}  tier=${out.tier[a.id]}`,
    );
  }
  if (rawReports.length === 0) console.log("   (no reports on chain)");
  for (const r of rawReports) {
    const w = out.reportWeights[r.id.toLowerCase()];
    console.log(
      `\n   report ${r.id}\n     tx ${r.tx}\n     ${handles.get(r.raw[0]) ?? r.raw[0]} -> ${handles.get(r.raw[1]) ?? r.raw[1]}` +
        `  state=${r.stateName}  weightPoints=${r.raw[3]} (${(Number(r.raw[3]) / 100).toFixed(2)} pts)  bond=${formatEther(r.raw[4])} VOUCHME` +
        `\n     filedAt=${new Date(Number(r.raw[5]) * 1000).toISOString()}  resolvedAt=${r.raw[6] === 0n ? "—" : new Date(Number(r.raw[6]) * 1000).toISOString()}` +
        `\n     engine: valid=${w?.valid} void=${w?.voidReason ?? "—"} base=${((w?.baseWeight ?? 0) / 100).toFixed(2)} ` +
        `decayed=${((w?.decayedWeight ?? 0) / 100).toFixed(2)} countedTowardScore=${w?.countedTowardScore} countedTowardRisk=${w?.countedTowardRisk}`,
    );
  }
  return out;
}

// ── steps ───────────────────────────────────────────────────────────────────────────────────────

async function wire() {
  console.log("── wiring (governor) ──");
  if (await read(ADDR.reportRegistry, abi.attestors, "attestors", [attestor.address])) {
    console.log("   ReportRegistry.attestors[attestor] already true");
  } else {
    console.log(`   ReportRegistry.setAttestor(${attestor.address}, true)`);
    await send(governor, ADDR.reportRegistry, abi.setAttestor, "setAttestor", [attestor.address, true]);
  }
  if (await read(ADDR.token, abi.minters, "minters", [governor.address])) {
    console.log("   VouchMeToken.minters[governor] already true");
  } else {
    console.log(`   VouchMeToken.setMinter(${governor.address}, true)`);
    await send(governor, ADDR.token, abi.setMinter, "setMinter", [governor.address, true]);
  }
}

/** Gas for three demo accounts, plus the VOUCHME bond each reporter needs in CredibilityVault.
 *  `BOND_PER_WEIGHT` is 10 VOUCHME per weight POINT and `weightPoints` is centi-points, so a 10.00-point
 *  report bonds 10 000 VOUCHME. */
async function fund(bondPerReporter) {
  console.log("── funding ──");
  // 0.00005 ETH. Gas on World Chain is ~0.0015 gwei, so this is far more than the ~5 transactions
  // these accounts send — but `eth_estimateGas` fails outright when the sender's balance cannot
  // cover gasLimit × gasPrice at the estimator's own price, and `file()` is the heaviest call here
  // (a struct write plus a vault lock).
  const gasEach = 50_000_000_000_000n;
  for (const [label, acct] of Object.entries(DEMO)) {
    const bal = await publicClient.getBalance({ address: acct.address });
    if (bal >= gasEach) {
      console.log(`   ${label} ${acct.address} already funded (${formatEther(bal)} ETH)`);
      continue;
    }
    console.log(`   ${label} ${acct.address} <- ${formatEther(gasEach)} ETH`);
    const hash = await wallet(governor).sendTransaction({ to: acct.address, value: gasEach });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    console.log(`   tx ${hash}  block ${receipt.blockNumber}`);
  }

  for (const label of ["reporterA", "reporterB"]) {
    const acct = DEMO[label];
    const pos = await read(ADDR.vault, abi.positions, "positions", [acct.address]);
    if (pos[0] >= bondPerReporter) {
      console.log(`   ${label} already has ${formatEther(pos[0])} VOUCHME bonded`);
      continue;
    }
    const need = bondPerReporter - pos[0];
    console.log(`   mint ${formatEther(need)} VOUCHME -> governor, approve vault, bondFor(${label})`);
    await send(governor, ADDR.token, abi.mint, "mint", [governor.address, need]);
    await send(governor, ADDR.token, abi.approve, "approve", [ADDR.vault, need]);
    await send(governor, ADDR.vault, abi.bondFor, "bondFor", [acct.address, need]);
  }
}

async function enroll() {
  console.log("── enrolling demo accounts ──");
  for (const [label, acct] of Object.entries(DEMO)) {
    const m = await read(ADDR.vouchMeRegistry, abi.members, "members", [acct.address]);
    if (m[6]) {
      console.log(`   ${label} ${acct.address} already enrolled`);
      continue;
    }
    const message = {
      account: acct.address,
      nullifierHash: demoNullifier(label),
      credential: CRED_SELFIE,
      deadline: nowSec() + 280n,
      nonce: randNonce(),
    };
    const attestation = await signEnroll(message);
    console.log(`   enroll ${label} ${acct.address} as ${HANDLES[label]}`);
    await send(acct, ADDR.vouchMeRegistry, abi.enroll, "enroll", [
      message.nullifierHash,
      message.credential,
      HANDLES[label],
      message.deadline,
      message.nonce,
      attestation,
    ]);
  }
}

async function fileReport(reporterLabel, evidence) {
  const reporter = DEMO[reporterLabel];
  const target = DEMO.target;

  const { input, handles } = await buildEngineInput();
  const out = compute(input);
  const reporterScore = out.score[reporter.address];
  if (reporterScore === undefined) throw new Error(`${reporterLabel} is not in the graph — enroll first.`);
  const weightPoints = weightNeg(reporterScore);
  console.log(
    `── filing: ${HANDLES[reporterLabel]} -> ${HANDLES.target}\n` +
      `   reporter score ${(reporterScore / 100).toFixed(2)} (tier ${out.tier[reporter.address]}), ` +
      `weightNeg = ${weightPoints} centi-points = ${(weightPoints / 100).toFixed(2)} points`,
  );
  console.log(
    `   NOTE: tier ${out.tier[reporter.address]} < 1, so /api/report/attest REFUSES to sign this ` +
      `(docs/12-reporting.md §2). Signing directly; the weight is the honest live value.`,
  );

  const message = {
    reporter: reporter.address,
    target: target.address,
    weightPoints,
    deadline: nowSec() + 280n,
    nonce: randNonce(),
  };
  const attestation = await signReport(message);
  const evidenceHash = evidence ? keccak256(toBytes(evidence)) : `0x${"0".repeat(64)}`;
  if (evidence) console.log(`   evidenceHash = keccak256("${evidence}") = ${evidenceHash}`);

  const receipt = await send(reporter, ADDR.reportRegistry, abi.file, "file", [
    target.address,
    evidenceHash,
    weightPoints,
    message.deadline,
    message.nonce,
    attestation,
  ]);
  const filed = receipt.logs.find((l) => l.address.toLowerCase() === ADDR.reportRegistry.toLowerCase());
  console.log(`   report id ${filed?.topics[1]}`);
  void handles;
}

async function withdrawReport(reporterLabel) {
  const reporter = DEMO[reporterLabel];
  const filedLogs = await publicClient.getLogs({
    address: ADDR.reportRegistry,
    event: parseAbiItem(
      "event ReportFiled(bytes32 indexed id, address indexed reporter, address indexed target, uint32 weightPoints, uint128 bond, bytes32 evidenceHash)",
    ),
    args: { reporter: reporter.address },
    fromBlock: DEPLOY_BLOCK,
    toBlock: await publicClient.getBlockNumber(),
  });
  if (filedLogs.length === 0) throw new Error(`${reporterLabel} has filed nothing to withdraw.`);
  const id = filedLogs[filedLogs.length - 1].args.id;
  console.log(`── withdrawing ${id} (10% bond burn, docs/12-reporting.md §4) ──`);
  await send(reporter, ADDR.reportRegistry, abi.withdrawReport, "withdrawReport", [id]);
}

async function main() {
  const args = process.argv.slice(2);
  console.log(`chain ${await publicClient.getChainId()}  block ${await publicClient.getBlockNumber()}`);
  console.log(`governor ${governor.address}  balance ${formatEther(await publicClient.getBalance({ address: governor.address }))} ETH`);
  console.log(`attestor ${attestor.address}`);
  for (const [label, acct] of Object.entries(DEMO)) console.log(`${label.padEnd(10)} ${acct.address}`);

  // 10.00 points of weight = 1000 centi-points = 10 000 VOUCHME at BOND_PER_WEIGHT = 10e18.
  const BOND = 10_000n * 10n ** 18n;

  if (args.includes("--wire")) await wire();
  if (args.includes("--fund")) await fund(BOND);
  if (args.includes("--enroll")) await enroll();
  if (args.includes("--file")) await fileReport("reporterA", "vouchme-demo-evidence: reportdemo-a accuses reportdemo-target");
  if (args.includes("--file-b")) await fileReport("reporterB", null);
  if (args.includes("--withdraw-b")) await withdrawReport("reporterB");
  if (args.includes("--state") || args.length === 0) printState(await buildEngineInput());
}

await main();
