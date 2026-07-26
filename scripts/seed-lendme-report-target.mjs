// scripts/seed-lendme-report-target.mjs
//
// Gives the report demo a subject who actually has something to lose.
//
// `mallory`, enrolled by seed-lendme-platform.mjs, sits at the floor: s⁺ = BASE = 20.00 and no
// vouches. docs/12-reporting.md §1 is explicit that `score = max(base, s⁺ − Σd)`, so a report
// against her is valid, filed, and bonded — and moves nothing, because "a report can take away
// everything people gave you; it cannot take away the fact that you are a live human."
//
// This script enrols a SECOND subject and has the same eight humans vouch for them, so their score
// is 20.00 + 8 × weightPos(20.00) = 60.00 — Tier 1, and 40.00 of it removable. A report of weight
// 20.00 against them visibly drops the score to 40.00, which is the demo actually showing the
// mechanism instead of asserting it.
//
// Separate from the platform script on purpose: that one is the prerequisite and must stay
// re-runnable without touching subjects. Idempotent in the same way.

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, parseEther, toBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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

// Same cohort and seed as seed-lendme-platform.mjs — the eight vouchers are reused, because their
// scores are what set the subject's standing.
const SEED = "vouchme/lendme-report-demo/v1";
const derive = (label) => privateKeyToAccount(keccak256(toBytes(`${SEED}::${label}`)));
const voucherAccounts = Array.from({ length: 8 }, (_, i) => derive(`lendme-voucher-${i + 1}`));
const subject = derive("dodgy");
const SUBJECT_HANDLE = "dodgy";

const registryAbi = [
  { type: "function", name: "enroll", inputs: [{ type: "uint256" }, { type: "bytes32" }, { type: "string" }, { type: "uint64" }, { type: "uint256" }, { type: "bytes" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "vouch", inputs: [{ type: "address" }, { type: "uint8" }, { type: "uint64" }, { type: "uint256" }, { type: "bytes" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "isEnrolled", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "isActiveVoucher", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
];

const domain = { name: "VouchMeRegistry", version: "1", chainId: CHAIN_ID, verifyingContract: REGISTRY };
const TYPES = {
  EnrollAttestation: [
    { name: "account", type: "address" },
    { name: "nullifierHash", type: "uint256" },
    { name: "credential", type: "bytes32" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
  VouchAttestation: [
    { name: "voucher", type: "address" },
    { name: "vouchee", type: "address" },
    { name: "voucherTier", type: "uint8" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};

const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 240);
let counter = 0n;
const freshNonce = () => BigInt(Date.now()) * 1_000_000n + counter++;
const signAttestation = (primaryType, message) =>
  attestor.signTypedData({ domain, types: { [primaryType]: TYPES[primaryType] }, primaryType, message });

async function send(account, params) {
  const hash = await wallet(account).writeContract(params);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`reverted: ${hash}`);
  return hash;
}

async function main() {
  console.log("Subject:", subject.address, `(handle "${SUBJECT_HANDLE}")`);

  const balance = await pub.getBalance({ address: subject.address });
  if (balance < parseEther("0.00001")) {
    const hash = await wallet(governor).sendTransaction({ to: subject.address, value: parseEther("0.00004") });
    await pub.waitForTransactionReceipt({ hash });
    console.log("  funded gas");
  }

  if (await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isEnrolled", args: [subject.address] })) {
    console.log("  already enrolled");
  } else {
    const credential = keccak256(toHex("selfie-check"));
    const nullifierHash = BigInt(keccak256(toHex(`${SEED}::nullifier::${SUBJECT_HANDLE}`)));
    const dl = deadline();
    const nc = freshNonce();
    const attestation = await signAttestation("EnrollAttestation", {
      account: subject.address,
      nullifierHash,
      credential,
      deadline: dl,
      nonce: nc,
    });
    console.log("  enroll:", await send(subject, {
      address: REGISTRY,
      abi: registryAbi,
      functionName: "enroll",
      args: [nullifierHash, credential, SUBJECT_HANDLE, dl, nc, attestation],
    }));
  }

  // Eight vouches, one per voucher. VouchMeRegistry rate-limits a voucher to one vouch per 24h, and
  // these are eight DIFFERENT vouchers doing one each, so they run concurrently.
  const already = await Promise.all(
    voucherAccounts.map((a) => pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: "isActiveVoucher", args: [a.address, subject.address] })),
  );
  const todo = voucherAccounts.filter((_, i) => !already[i]);
  if (todo.length === 0) {
    console.log("  already vouched by the whole cohort");
  } else {
    const results = await Promise.allSettled(
      todo.map(async (a) => {
        const dl = deadline();
        const nc = freshNonce();
        const attestation = await signAttestation("VouchAttestation", {
          voucher: a.address,
          vouchee: subject.address,
          voucherTier: 1,
          deadline: dl,
          nonce: nc,
        });
        await send(a, { address: REGISTRY, abi: registryAbi, functionName: "vouch", args: [subject.address, 1, dl, nc, attestation] });
      }),
    );
    for (const [i, r] of results.entries()) {
      console.log(`  vouch from ${todo[i].address.slice(0, 8)}…: ${r.status === "fulfilled" ? "ok" : `FAILED — ${String(r.reason?.shortMessage ?? r.reason).split("\n")[0]}`}`);
    }
  }

  console.log("\nExpected standing: 20.00 base + 8 × 5.00 = 60.00 (Tier 1), of which 40.00 is removable.");
  console.log(`Report "${SUBJECT_HANDLE}" from Lend and the score should fall to 40.00.`);
}

main().catch((e) => {
  console.error("\nFAILED:", e.shortMessage ?? e.message);
  process.exit(1);
});
