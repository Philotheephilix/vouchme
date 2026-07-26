// scripts/enroll-demo-human.mjs
//
// Enrol one or more humans on World Chain by handle:
//
//     node scripts/enroll-demo-human.mjs romario philotheephilix
//
// The handle is the point. `app/src/lib/chain.ts` maps the on-chain `Enrolled.handle` straight onto
// the graph's `ensName`, so enrolling with `romario` is what makes `/api/score/romario` and
// `romario.vouchme.eth` resolve — no ENS registration on Ethereum Sepolia required for lookup.
//
// Keys are derived deterministically from the same public seed as the rest of the report demo, so
// re-running with the same handle always means the same address, and the script is idempotent.
//
// This bypasses the World ID widget, which is exactly what an attestor key is for: `enroll` checks
// an EIP-712 attestation and nullifier uniqueness, never a ZK proof (contracts/src/VouchMeRegistry
// .sol). The nullifier here is derived from the handle — unique and unused, which is all the
// contract requires of it. That means these accounts are NOT proof-of-human; they are seeded
// identities for a demo graph, and nothing about them should be read as a verified person.

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, parseEther, toBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const handles = process.argv.slice(2).map((h) => h.trim().replace(/\.vouchme\.eth$/, "").replace(/\.eth$/, "").replace(/\.$/, "").toLowerCase());
if (handles.length === 0) {
  console.error("usage: node scripts/enroll-demo-human.mjs <handle> [<handle>...]");
  process.exit(1);
}
// Same rule the enrol page enforces (app/src/app/enroll/page.tsx HANDLE_RE), applied here so a
// handle that the app would reject never reaches the chain, where it is permanent.
const HANDLE_RE = /^[a-z0-9-]{3,20}$/;
for (const h of handles) {
  if (!HANDLE_RE.test(h) || h.startsWith("-") || h.endsWith("-")) {
    console.error(`"${h}" is not a valid handle: 3-20 chars, a-z 0-9 and hyphen, not leading or trailing.`);
    process.exit(1);
  }
}

function readEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    out[t.slice(0, i)] = t.slice(i + 1).trim();
  }
  return out;
}

const here = (p) => new URL(p, import.meta.url).pathname;
const contractsEnv = readEnv(here("../contracts/.env"));
const appEnv = readEnv(here("../app/.env.local"));

const CHAIN_ID = 480;
const RPC = appEnv.WORLDCHAIN_RPC;
const governor = privateKeyToAccount(contractsEnv.PRIVATE_KEY);
const attestor = privateKeyToAccount(contractsEnv.ATTESTOR_PRIVATE_KEY);
const REGISTRY = getAddress(appEnv.VOUCHME_REGISTRY_ADDRESS.toLowerCase());

const chain = {
  id: CHAIN_ID,
  name: "World Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (account) => createWalletClient({ account, chain, transport: http(RPC) });

const SEED = "vouchme/lendme-report-demo/v1";
const keyFor = (label) => keccak256(toBytes(`${SEED}::${label}`));
const derive = (label) => privateKeyToAccount(keyFor(label));

const registryAbi = [
  { type: "function", name: "enroll", inputs: [{ type: "uint256" }, { type: "bytes32" }, { type: "string" }, { type: "uint64" }, { type: "uint256" }, { type: "bytes" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "isEnrolled", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
];

const domain = { name: "VouchMeRegistry", version: "1", chainId: CHAIN_ID, verifyingContract: REGISTRY };
const ENROLL_TYPE = {
  EnrollAttestation: [
    { name: "account", type: "address" },
    { name: "nullifierHash", type: "uint256" },
    { name: "credential", type: "bytes32" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};

let counter = 0n;
const freshNonce = () => BigInt(Date.now()) * 1_000_000n + counter++;

async function main() {
  const people = handles.map((handle) => ({ handle, account: derive(handle) }));
  for (const p of people) console.log(`${p.handle.padEnd(18)} ${p.account.address}`);

  const enrolled = await Promise.all(
    people.map((p) => pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isEnrolled", args: [p.account.address] })),
  );
  const todo = people.filter((_, i) => !enrolled[i]);
  for (const [i, p] of people.entries()) if (enrolled[i]) console.log(`  ${p.handle}: already enrolled`);
  if (todo.length === 0) return;

  // Gas first, from one account with explicit nonces so the transfers go out together.
  const balances = await Promise.all(todo.map((p) => pub.getBalance({ address: p.account.address })));
  const needy = todo.filter((_, i) => balances[i] < parseEther("0.00001"));
  if (needy.length > 0) {
    let n = await pub.getTransactionCount({ address: governor.address });
    const w = wallet(governor);
    const hashes = await Promise.all(needy.map((p) => w.sendTransaction({ to: p.account.address, value: parseEther("0.00004"), nonce: n++ })));
    await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash })));
    console.log(`  funded gas for ${needy.length}`);
  }

  const credential = keccak256(toHex("selfie-check"));
  // Each enrolment is sent by a different key, so these run concurrently.
  const results = await Promise.allSettled(
    todo.map(async (p) => {
      const nullifierHash = BigInt(keccak256(toHex(`${SEED}::nullifier::${p.handle}`)));
      // MAX_ATTESTATION_TTL is 5 minutes, so the deadline is minted here and used immediately.
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 240);
      const nonce = freshNonce();
      const attestation = await attestor.signTypedData({
        domain,
        types: ENROLL_TYPE,
        primaryType: "EnrollAttestation",
        message: { account: p.account.address, nullifierHash, credential, deadline, nonce },
      });
      const hash = await wallet(p.account).writeContract({
        address: REGISTRY,
        abi: registryAbi,
        functionName: "enroll",
        args: [nullifierHash, credential, p.handle, deadline, nonce, attestation],
      });
      const rcpt = await pub.waitForTransactionReceipt({ hash });
      if (rcpt.status !== "success") throw new Error(`reverted: ${hash}`);
      return hash;
    }),
  );

  for (const [i, r] of results.entries()) {
    console.log(`  ${todo[i].handle}: ${r.status === "fulfilled" ? r.value : `FAILED — ${String(r.reason?.shortMessage ?? r.reason).split("\n")[0]}`}`);
  }
  console.log("\nPrivate keys (deterministic from the public seed, demo only):");
  for (const p of people) console.log(`  ${p.handle.padEnd(18)} ${keyFor(p.handle)}`);
}

main().catch((e) => {
  console.error("\nFAILED:", e.shortMessage ?? e.message);
  process.exit(1);
});
