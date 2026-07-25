// scripts/live-scenario.mjs
//
// Runs the live scenario against VouchMeRegistry on World Chain Sepolia: real transactions, real
// EIP-712 attestations, real gas. Re-runnable: every step checks on-chain state first and skips
// work that already landed.
//
// ── Attestor model ──────────────────────────────────────────────────────────────────────────
// ATTESTOR_ADDRESS is the deployer for this testnet deployment (contracts/.env), so all
// attestations here are signed with the deployer's own PRIVATE_KEY, not the separate
// ATTESTOR_PRIVATE_KEY in .env — only ATTESTOR_ADDRESS is in the on-chain `attestors` allowlist,
// so that key would sign attestations VouchMeRegistry does not recognize.
//
// This script's attestor does not query a real-time computed tier before signing a vouch
// attestation — it asserts a nominal tier from the account's *kind* (2 for anchors, matching
// the "Anchor: 10 slots" row of docs/01-trust-math.md §1; 1 for every other enrolled member,
// matching "Member: can vouch if tier ≥ 1" / 3 slots) and nothing more. That is deliberate:
// VouchMeRegistry.sol's own doc comment says outright that "a forged attestation buys an edge the
// Subgraph recompute simply will not credit" — the contract's job is to record a fact (an edge
// was attested and issued), not to arbitrate merit. The ring1..ring6 leg of this scenario only
// makes sense under this model: those accounts have no anchor path and a true engine-computed
// tier of 0, yet the point is to show their vouches land on chain and still net a base score.
// "Attested tier" (on-chain, asserted) and "computed tier" (off-chain, earned) are distinct.
//
// ── The anchor rate-limit collision (bob) ───────────────────────────────────────────────────
// VouchMeRegistry's vouch rate limit is 1 vouch / 24h *per voucher*, not per (voucher, vouchee)
// pair — so anchor1, having spent its one vouch for the day on alice, cannot also vouch bob in
// the same session. With exactly 3 anchors and 2 anchor-vouches required for each of 2 targets,
// that is 4 vouch-slots of demand against 3 anchors' worth of daily capacity: by pigeonhole,
// *no* assignment of anchor1/2/3 across alice and bob avoids one anchor being asked to vouch
// twice in one day. This script attempts anchor1→bob anyway, captures the real on-chain revert,
// and then completes bob's promotion with anchor3 — the only anchor with capacity left. Bob ends
// up with one anchor vouch, not two: a consequence of the rate limit meeting a finite anchor
// pool in one session, not a bug.

import { createWalletClient, createPublicClient, http, keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { deriveIdentities, ANCHOR_LABELS, MEMBER_LABELS, RING_LABELS } from "./identities.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
process.loadEnvFile(`${REPO_ROOT}contracts/.env`);

const RPC_URL = process.env.WORLDCHAIN_SEPOLIA_RPC;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const deployments = JSON.parse(readFileSync(`${REPO_ROOT}deployments/worldchain-sepolia.json`, "utf8"));
const REGISTRY_ADDRESS = deployments.contracts.VouchMeRegistry.address;
const registryArtifact = JSON.parse(
  readFileSync(`${REPO_ROOT}contracts/out/VouchMeRegistry.sol/VouchMeRegistry.json`, "utf8")
);
const ABI = registryArtifact.abi;

const worldChainSepolia = {
  id: 4801,
  name: "World Chain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const publicClient = createPublicClient({ chain: worldChainSepolia, transport: http(RPC_URL) });
const attestor = privateKeyToAccount(PRIVATE_KEY); // == deployer == ATTESTOR_ADDRESS == GOVERNOR_ADDRESS
const identities = deriveIdentities();

const walletClients = Object.fromEntries(
  Object.entries(identities).map(([label, account]) => [
    label,
    createWalletClient({ account, chain: worldChainSepolia, transport: http(RPC_URL) }),
  ])
);

const CRED_ORB = keccak256(toBytes("orb"));
const CRED_SELFIE = keccak256(toBytes("selfie-check"));

function domain() {
  return {
    name: "VouchMeRegistry",
    version: "1",
    chainId: BigInt(worldChainSepolia.id),
    verifyingContract: REGISTRY_ADDRESS,
  };
}

async function nowPlusTtl(seconds = 280) {
  const block = await publicClient.getBlock();
  return block.timestamp + BigInt(seconds);
}

function randomNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return BigInt(keccak256(bytes));
}

function nullifierFor(label) {
  return BigInt(keccak256(toBytes(`vouchme-livescenario-nullifier:${label}`)));
}

async function signEnroll(account, nullifierHash, credential, deadline, nonce) {
  return attestor.signTypedData({
    domain: domain(),
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
    message: { account, nullifierHash, credential, deadline, nonce },
  });
}

async function signVouch(voucher, vouchee, voucherTier, deadline, nonce) {
  return attestor.signTypedData({
    domain: domain(),
    types: {
      VouchAttestation: [
        { name: "voucher", type: "address" },
        { name: "vouchee", type: "address" },
        { name: "voucherTier", type: "uint8" },
        { name: "deadline", type: "uint64" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "VouchAttestation",
    message: { voucher, vouchee, voucherTier, deadline, nonce },
  });
}

async function isEnrolled(address) {
  return publicClient.readContract({ address: REGISTRY_ADDRESS, abi: ABI, functionName: "isEnrolled", args: [address] });
}

async function isActiveVoucher(voucher, vouchee) {
  return publicClient.readContract({
    address: REGISTRY_ADDRESS,
    abi: ABI,
    functionName: "isActiveVoucher",
    args: [voucher, vouchee],
  });
}

async function enrollIdentity(label, { orb }) {
  const account = identities[label];
  if (await isEnrolled(account.address)) {
    console.log(`enroll  ${label.padEnd(8)} SKIP (already enrolled)`);
    return;
  }
  const nullifierHash = nullifierFor(label);
  const credential = orb ? CRED_ORB : CRED_SELFIE;
  const deadline = await nowPlusTtl();
  const nonce = randomNonce();
  const attestation = await signEnroll(account.address, nullifierHash, credential, deadline, nonce);
  const handle = `${label}.vouchme.eth`;

  const hash = await walletClients[label].writeContract({
    address: REGISTRY_ADDRESS,
    abi: ABI,
    functionName: "enroll",
    args: [nullifierHash, credential, handle, deadline, nonce, attestation],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`enroll(${label}) reverted: ${hash}`);
  console.log(`enroll  ${label.padEnd(8)} OK   tx=${hash}`);
}

/**
 * @param {{expectRevert?: boolean}} opts If expectRevert, force a manual gas limit so viem sends
 *   the transaction directly instead of failing at the eth_estimateGas step — we want a real
 *   mined, reverted transaction with a tx hash, not just a local simulation failure.
 */
async function vouch(voucherLabel, voucheeLabel, tier, opts = {}) {
  const voucher = identities[voucherLabel];
  const vouchee = identities[voucheeLabel];

  if (await isActiveVoucher(voucher.address, vouchee.address)) {
    console.log(`vouch   ${voucherLabel.padEnd(8)} -> ${voucheeLabel.padEnd(8)} SKIP (already active)`);
    return { skipped: true };
  }

  const deadline = await nowPlusTtl();
  const nonce = randomNonce();
  const attestation = await signVouch(voucher.address, vouchee.address, tier, deadline, nonce);

  const args = [vouchee.address, tier, deadline, nonce, attestation];
  const common = { address: REGISTRY_ADDRESS, abi: ABI, functionName: "vouch", args, account: voucher };

  if (opts.expectRevert) {
    try {
      const hash = await walletClients[voucherLabel].writeContract({ ...common, gas: 300_000n });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status === "success") {
        console.log(`vouch   ${voucherLabel.padEnd(8)} -> ${voucheeLabel.padEnd(8)} UNEXPECTEDLY SUCCEEDED tx=${hash}`);
        return { reverted: false, hash };
      }
      console.log(`vouch   ${voucherLabel.padEnd(8)} -> ${voucheeLabel.padEnd(8)} REVERTED on-chain (status 0) tx=${hash} — expected (rate limit)`);
      return { reverted: true, hash };
    } catch (e) {
      const reason = e?.cause?.reason ?? e?.shortMessage ?? e?.message ?? String(e);
      console.log(`vouch   ${voucherLabel.padEnd(8)} -> ${voucheeLabel.padEnd(8)} REVERTED before broadcast — ${reason}`);
      return { reverted: true, reason };
    }
  }

  const hash = await walletClients[voucherLabel].writeContract(common);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`vouch(${voucherLabel}->${voucheeLabel}) reverted unexpectedly: ${hash}`);
  console.log(`vouch   ${voucherLabel.padEnd(8)} -> ${voucheeLabel.padEnd(8)} OK   tx=${hash}`);
  return { reverted: false, hash };
}

async function main() {
  console.log(`VouchMeRegistry: ${REGISTRY_ADDRESS}\n`);

  console.log("── 1. enroll everyone ──────────────────────────────────────────");
  for (const label of ANCHOR_LABELS) await enrollIdentity(label, { orb: true });
  for (const label of [...MEMBER_LABELS, ...RING_LABELS]) await enrollIdentity(label, { orb: false });

  console.log("\n── 2. anchor1 + anchor2 vouch alice ────────────────────────────");
  await vouch("anchor1", "alice", 2);
  await vouch("anchor2", "alice", 2);

  console.log("\n── 3. anchor1 + anchor3 vouch bob (anchor1 expected to collide with its 24h rate limit) ──");
  const collision = await vouch("anchor1", "bob", 2, { expectRevert: true });
  if (!collision.reverted) {
    console.warn("WARNING: anchor1->bob did not revert as predicted. Investigate before trusting downstream numbers.");
  }
  await vouch("anchor3", "bob", 2);

  console.log("\n── 4. alice + bob vouch carol ──────────────────────────────────");
  await vouch("alice", "carol", 1);
  await vouch("bob", "carol", 1);

  console.log("\n── 5. ring1..ring6 directed cycle (achievable slice of the full clique; see task notes) ──");
  const ring = RING_LABELS;
  for (let i = 0; i < ring.length; i++) {
    const from = ring[i];
    const to = ring[(i + 1) % ring.length];
    await vouch(from, to, 1);
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
