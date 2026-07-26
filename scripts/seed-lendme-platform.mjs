// scripts/seed-lendme-platform.mjs
//
// Makes LendMe a REAL registered platform at tier P1 on World Chain mainnet, so that
// `ReportRegistry.file()` from LendMe actually succeeds instead of reverting.
//
// ── Why this script has to exist ─────────────────────────────────────────────────────────────
// A platform report has four prerequisites, and none of them can be faked at the contract layer:
//
//   1. `PlatformRegistry.registerPlatform` — needs a 5 000 VOUCHME bond and an attestation from a
//      key allow-listed on THAT registry. The attestor was only ever allow-listed on
//      VouchMeRegistry, which is why enrollment worked in the app and nothing else did.
//   2. Platform tier >= P1 (40.00). `sPlatform` is computed by the engine from platform vouches:
//      `pos = Σ weightPos(voucherScore ?? BASE)` (engine/src/score.ts). With BASE = 20.00 and
//      m⁺ = 0.25 every enrolled human contributes exactly 5.00, so EIGHT vouchers put the platform
//      at exactly 40.00. `activePlatformVouches` filters on active + human voucher + platform
//      target and applies NO tier gate, so tier-0 vouchers count — the only reason this is
//      reachable without Orb anchors, whose status comes from World's Address Book and cannot be
//      granted by anyone here.
//   3. `ReportRegistry.file` needs an attestation from a key allow-listed on the REPORT registry.
//   4. `vault.lockForReport` locks the bond from an EXISTING `bonded - locked` position, so the
//      platform must bond into CredibilityVault up front; nothing is pulled at filing time.
//
// ── What it deliberately does not do ────────────────────────────────────────────────────────
// It does not invent anchors, tiers or scores. `voucherTier` in the attestations is asserted (the
// contract only rejects 0 and never checks it against a score), but that changes nothing the
// engine computes — the engine recomputes `sPlatform` from the graph, which is exactly why eight
// real vouchers are needed rather than one with a flattering tier.
//
// Idempotent: every phase reads current state first and skips what is already done, so a partial
// run is safe to repeat.

import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, getAddress, http, keccak256, parseEther, toBytes, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// ─── env ─────────────────────────────────────────────────────────────────────────────────────

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

// The governor owns setAttestor/setMinter on all four contracts. The attestor is a DIFFERENT key,
// and is the one already allow-listed on VouchMeRegistry.
const governor = privateKeyToAccount(contractsEnv.PRIVATE_KEY);
const attestor = privateKeyToAccount(contractsEnv.ATTESTOR_PRIVATE_KEY);

// Addresses in .env.local are not EIP-55 checksummed (app/src/lib/chain.ts tolerates this by
// lower-casing before `getAddress`, so the same is done here rather than hand-fixing the casing).
const norm = (a) => getAddress(a.toLowerCase());
const ADDR = {
  token: norm(appEnv.VOUCHME_TOKEN_ADDRESS),
  registry: norm(appEnv.VOUCHME_REGISTRY_ADDRESS),
  platform: norm(appEnv.PLATFORM_REGISTRY_ADDRESS),
  report: norm(appEnv.REPORT_REGISTRY_ADDRESS),
  vault: norm(appEnv.CREDIBILITY_VAULT_ADDRESS),
};

const chain = {
  id: CHAIN_ID,
  name: "World Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
};
const pub = createPublicClient({ chain, transport: http(RPC) });
const wallet = (account) => createWalletClient({ account, chain, transport: http(RPC) });

// ─── the demo cohort ─────────────────────────────────────────────────────────────────────────
// Same derivation style as scripts/identities.mjs — keccak256(SEED + "::" + label), public and
// reproducible — under a deliberately DIFFERENT seed, so this cohort can never be mistaken for
// the live-scenario identities.

const SEED = "vouchme/lendme-report-demo/v1";
const keyFor = (label) => keccak256(toBytes(`${SEED}::${label}`));
const derive = (label) => privateKeyToAccount(keyFor(label));

const platformAccount = derive("lendme-platform");
const voucherAccounts = Array.from({ length: 8 }, (_, i) => derive(`lendme-voucher-${i + 1}`));
/** The person the demo reports: a real enrolled human with a real handle, so the report page can
 *  be driven by name (`mallory`) rather than by a raw address. `chain.ts` maps the on-chain enroll
 *  handle straight onto the graph's `ensName`, so the name becomes resolvable by enrolling. */
const targetAccount = derive("mallory");
const TARGET_HANDLE = "mallory";

// ─── EIP-712 ─────────────────────────────────────────────────────────────────────────────────
// Domain names verified against each contract's own `domainSeparator()` getter before this script
// was written: "VouchMeRegistry", "PlatformRegistry", "ReportRegistry", all version "1". A wrong
// name produces a signature that reverts with `BadAttestation` and nothing to explain why.

const domainFor = (name, verifyingContract) => ({ name, version: "1", chainId: CHAIN_ID, verifyingContract });

const TYPES = {
  EnrollAttestation: [
    { name: "account", type: "address" },
    { name: "nullifierHash", type: "uint256" },
    { name: "credential", type: "bytes32" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
  RegisterAttestation: [
    { name: "platform", type: "address" },
    { name: "ensNameHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
  PlatformVouchAttestation: [
    { name: "human", type: "address" },
    { name: "platform", type: "address" },
    { name: "voucherTier", type: "uint8" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
};

/** MAX_ATTESTATION_TTL is 5 minutes, so this is generated per transaction and used immediately. */
const deadline = () => BigInt(Math.floor(Date.now() / 1000) + 240);
let nonceCounter = 0n;
const freshNonce = () => BigInt(Date.now()) * 1_000_000n + nonceCounter++;

const signAttestation = (domain, primaryType, message) =>
  attestor.signTypedData({ domain, types: { [primaryType]: TYPES[primaryType] }, primaryType, message });

// ─── minimal ABIs ────────────────────────────────────────────────────────────────────────────

const tokenAbi = [
  { type: "function", name: "setMinter", inputs: [{ type: "address" }, { type: "bool" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "mint", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "approve", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "minters", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
];
const registryAbi = [
  { type: "function", name: "enroll", inputs: [{ type: "uint256" }, { type: "bytes32" }, { type: "string" }, { type: "uint64" }, { type: "uint256" }, { type: "bytes" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "isEnrolled", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
];
const platformAbi = [
  { type: "function", name: "setAttestor", inputs: [{ type: "address" }, { type: "bool" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "attestors", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "registerPlatform", inputs: [{ type: "string" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint128" }, { type: "uint64" }, { type: "uint256" }, { type: "bytes" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "vouchPlatform", inputs: [{ type: "address" }, { type: "uint8" }, { type: "uint64" }, { type: "uint256" }, { type: "bytes" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "isRegistered", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
];
const reportAbi = [
  { type: "function", name: "setAttestor", inputs: [{ type: "address" }, { type: "bool" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "attestors", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
];
const vaultAbi = [
  { type: "function", name: "bond", inputs: [{ type: "uint128" }], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "positions", inputs: [{ type: "address" }], outputs: [{ type: "uint128" }, { type: "uint128" }], stateMutability: "view" },
];

// ─── helpers ─────────────────────────────────────────────────────────────────────────────────

const log = (...a) => console.log(...a);

async function send(account, params) {
  const hash = await wallet(account).writeContract(params);
  const rcpt = await pub.waitForTransactionReceipt({ hash });
  if (rcpt.status !== "success") throw new Error(`reverted: ${hash}`);
  return hash;
}

// ─── phases ──────────────────────────────────────────────────────────────────────────────────

async function phaseGovernorRights() {
  log("\n── governor rights ─────────────────────────────");
  const [platAtt, reportAtt, isMinter] = await Promise.all([
    pub.readContract({ address: ADDR.platform, abi: platformAbi, functionName: "attestors", args: [attestor.address] }),
    pub.readContract({ address: ADDR.report, abi: reportAbi, functionName: "attestors", args: [attestor.address] }),
    pub.readContract({ address: ADDR.token, abi: tokenAbi, functionName: "minters", args: [governor.address] }),
  ]);

  if (platAtt) log("  PlatformRegistry attestor already allow-listed");
  else log("  PlatformRegistry.setAttestor:", await send(governor, { address: ADDR.platform, abi: platformAbi, functionName: "setAttestor", args: [attestor.address, true] }));

  if (reportAtt) log("  ReportRegistry attestor already allow-listed");
  else log("  ReportRegistry.setAttestor:  ", await send(governor, { address: ADDR.report, abi: reportAbi, functionName: "setAttestor", args: [attestor.address, true] }));

  if (isMinter) log("  governor already a minter");
  else log("  VouchMeToken.setMinter:      ", await send(governor, { address: ADDR.token, abi: tokenAbi, functionName: "setMinter", args: [governor.address, true] }));
}

async function phaseFund() {
  log("\n── mint + gas ──────────────────────────────────");
  // 5 000 for registration and the rest as vault bond headroom. `weightPoints` is chosen by
  // VouchMe's attestation route and the bond is 10 VOUCHME per point, so this is deliberately
  // generous rather than exactly computed.
  const bal = await pub.readContract({ address: ADDR.token, abi: tokenAbi, functionName: "balanceOf", args: [platformAccount.address] });
  if (bal >= parseEther("50000")) log("  platform already holds VOUCHME:", (Number(bal) / 1e18).toFixed(0));
  else log("  mint 100 000 VOUCHME:", await send(governor, { address: ADDR.token, abi: tokenAbi, functionName: "mint", args: [platformAccount.address, parseEther("100000")] }));

  // Gas: 0.0015 gwei on World Chain, so 0.00004 ETH is ~180 transactions of headroom each.
  const needy = [platformAccount, targetAccount, ...voucherAccounts];
  const balances = await Promise.all(needy.map((a) => pub.getBalance({ address: a.address })));
  const toFund = needy.filter((_, i) => balances[i] < parseEther("0.00001"));
  if (toFund.length === 0) {
    log("  every account already has gas");
    return;
  }
  // Explicit sequential nonces so one account's transfers can be broadcast concurrently.
  let n = await pub.getTransactionCount({ address: governor.address });
  const w = wallet(governor);
  const hashes = await Promise.all(toFund.map((a) => w.sendTransaction({ to: a.address, value: parseEther("0.00004"), nonce: n++ })));
  await Promise.all(hashes.map((hash) => pub.waitForTransactionReceipt({ hash })));
  log(`  funded ${toFund.length} accounts with gas`);
}

async function phaseEnroll() {
  log("\n── enroll the cohort ───────────────────────────");
  const domain = domainFor("VouchMeRegistry", ADDR.registry);
  // `enroll` records the credential without checking it against the Address Book, so the
  // selfie-check credential needs no Orb verification behind it.
  const credential = keccak256(toHex("selfie-check"));

  const people = [
    ...voucherAccounts.map((account, i) => ({ account, handle: `lm-voucher-${i + 1}` })),
    { account: targetAccount, handle: TARGET_HANDLE },
  ];
  const enrolled = await Promise.all(
    people.map((p) => pub.readContract({ address: ADDR.registry, abi: registryAbi, functionName: "isEnrolled", args: [p.account.address] })),
  );
  const todo = people.filter((_, i) => !enrolled[i]);
  if (todo.length === 0) {
    log("  whole cohort already enrolled");
    return;
  }

  // Each enrollment is signed by a DIFFERENT key, so these are genuinely concurrent.
  const results = await Promise.allSettled(
    todo.map(async (p) => {
      // What World ID would supply. It only has to be unique and unused — the contract enforces
      // uniqueness and nothing else reads it.
      const nullifierHash = BigInt(keccak256(toHex(`${SEED}::nullifier::${p.handle}`)));
      const dl = deadline();
      const nc = freshNonce();
      const attestation = await signAttestation(domain, "EnrollAttestation", {
        account: p.account.address,
        nullifierHash,
        credential,
        deadline: dl,
        nonce: nc,
      });
      await send(p.account, {
        address: ADDR.registry,
        abi: registryAbi,
        functionName: "enroll",
        args: [nullifierHash, credential, p.handle, dl, nc, attestation],
      });
      return p.handle;
    }),
  );
  for (const [i, r] of results.entries()) {
    log(`  ${todo[i].handle.padEnd(14)} ${r.status === "fulfilled" ? "enrolled" : `FAILED — ${String(r.reason?.shortMessage ?? r.reason).split("\n")[0]}`}`);
  }
}

async function phaseRegisterPlatform() {
  log("\n── register LendMe as a platform ───────────────");
  if (await pub.readContract({ address: ADDR.platform, abi: platformAbi, functionName: "isRegistered", args: [platformAccount.address] })) {
    log("  already registered");
    return;
  }
  const ensName = "lendme.vouchme.eth";
  const bond = parseEther("5000");
  log("  approve:", await send(platformAccount, { address: ADDR.token, abi: tokenAbi, functionName: "approve", args: [ADDR.platform, bond] }));

  const dl = deadline();
  const nc = freshNonce();
  const attestation = await signAttestation(domainFor("PlatformRegistry", ADDR.platform), "RegisterAttestation", {
    platform: platformAccount.address,
    ensNameHash: keccak256(toHex(ensName)),
    deadline: dl,
    nonce: nc,
  });
  log("  registerPlatform:", await send(platformAccount, {
    address: ADDR.platform,
    abi: platformAbi,
    functionName: "registerPlatform",
    args: [ensName, keccak256(toHex("lendme:metadata")), keccak256(toHex("lendme:policy")), bond, dl, nc, attestation],
  }));
}

async function phaseVouchPlatform() {
  log("\n── vouch LendMe to P1 ──────────────────────────");
  const domain = domainFor("PlatformRegistry", ADDR.platform);
  // Concurrent: one vouch each from eight distinct keys. 8 × weightPos(BASE 20.00) = 40.00 = P1.
  const results = await Promise.allSettled(
    voucherAccounts.map(async (a) => {
      const dl = deadline();
      const nc = freshNonce();
      const attestation = await signAttestation(domain, "PlatformVouchAttestation", {
        human: a.address,
        platform: platformAccount.address,
        voucherTier: 1,
        deadline: dl,
        nonce: nc,
      });
      await send(a, {
        address: ADDR.platform,
        abi: platformAbi,
        functionName: "vouchPlatform",
        args: [platformAccount.address, 1, dl, nc, attestation],
      });
    }),
  );
  for (const [i, r] of results.entries()) {
    log(`  voucher ${i + 1}: ${r.status === "fulfilled" ? "vouched" : `FAILED — ${String(r.reason?.shortMessage ?? r.reason).split("\n")[0]}`}`);
  }
}

async function phaseBondVault() {
  log("\n── bond into CredibilityVault ──────────────────");
  const want = parseEther("50000");
  const pos = await pub.readContract({ address: ADDR.vault, abi: vaultAbi, functionName: "positions", args: [platformAccount.address] }).catch(() => null);
  const bonded = Array.isArray(pos) ? pos[0] : 0n;
  if (bonded >= want) {
    log("  already bonded:", (Number(bonded) / 1e18).toFixed(0));
    return;
  }
  log("  approve:", await send(platformAccount, { address: ADDR.token, abi: tokenAbi, functionName: "approve", args: [ADDR.vault, want] }));
  log("  bond:   ", await send(platformAccount, { address: ADDR.vault, abi: vaultAbi, functionName: "bond", args: [want] }));
}

async function main() {
  log("LendMe platform :", platformAccount.address);
  log("Report target   :", targetAccount.address, `(handle "${TARGET_HANDLE}")`);
  log("Governor        :", governor.address);
  log("Attestor        :", attestor.address);
  log("RPC             :", RPC.replace(/\/v2\/.*$/, "/v2/***"));

  await phaseGovernorRights();
  await phaseFund();
  await phaseEnroll();
  await phaseRegisterPlatform();
  await phaseVouchPlatform();
  await phaseBondVault();

  log("\n── for example/lend/.env.local ─────────────────");
  log("LEND_PLATFORM_PRIVATE_KEY=" + keyFor("lendme-platform"));
  log("LEND_PLATFORM_ADDRESS=" + platformAccount.address);
  log("LEND_REPORT_DEMO_TARGET=" + TARGET_HANDLE);
}

main().catch((e) => {
  console.error("\nFAILED:", e.shortMessage ?? e.message);
  process.exit(1);
});
