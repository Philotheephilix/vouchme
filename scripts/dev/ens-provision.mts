/**
 * scripts/dev/ens-provision.mts   —   run with:  npx tsx scripts/dev/ens-provision.mts …
 *
 * Provisions the vouchme.eth member population on Ethereum Sepolia through the SAME code path the app
 * uses (`app/src/lib/ens-core.ts`), so nothing here can drift from what `/api/ens/mint` does.
 *
 * For each label it guarantees the complete, wired state:
 *   1. the member's own `PermissionedRegistry` clone, deployed through the `VerifiableFactory` at
 *      a CREATE2 address that is a pure function of the label,
 *   2. `<label>.vouchme.eth` registered in the vouchme.eth registry with that clone as `Entry.subregistry`
 *      (or, for labels that already exist, `setSubregistry` — never a second `register`),
 *   3. `addr(namehash("<label>.vouchme.eth")) == the member's address`,
 * and then re-reads all three with a FRESH client before claiming any of it worked.
 *
 * Usage:
 *   npx tsx scripts/dev/ens-provision.mts --check
 *   npx tsx scripts/dev/ens-provision.mts --label alice
 *   npx tsx scripts/dev/ens-provision.mts --all
 *   npx tsx scripts/dev/ens-provision.mts --vouch alice carol
 *   npx tsx scripts/dev/ens-provision.mts --setaddr erin.carol.alice.vouchme.eth erin
 */

import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { createPublicClient, createWalletClient, formatEther, http, namehash, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import {
  ALL_ROLES,
  SOULBOUND_ROLES,
  isNameSoulbound,
  VOUCHME_ETH_REGISTRY,
  VOUCHME_ETH_RESOLVER,
  DEPLOYER_ADDRESS,
  MEMBER_REGISTRY_SALT_NAMESPACE,
  REGISTRY_ABI,
  RESOLVER_ABI,
  ZERO_ADDRESS,
  getSubregistry,
  memberRegistrySalt,
  mintMemberName,
  mintVouchSubname,
  predictMemberRegistryAddress,
  type EnsClients,
  type EnsPublicClient,
  type EnsWalletClient,
} from "../../app/src/lib/ens-core.ts";

// @ts-expect-error — plain .mjs helper, no type declarations, deliberately shared with the other scripts.
import { deriveAddresses, LABELS } from "../identities.mjs";

process.loadEnvFile("/home/ubuntu/projects/lisboa/.env");

const RPC = process.env.ETH_SEPOLIA_RPC;
if (!RPC) throw new Error("ETH_SEPOLIA_RPC is not set");
const KEY = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
if (!KEY) throw new Error("DEPLOYER_PRIVATE_KEY / PRIVATE_KEY is not set");

const account = privateKeyToAccount(KEY as `0x${string}`);
if (account.address.toLowerCase() !== DEPLOYER_ADDRESS.toLowerCase()) {
  throw new Error(`key derives to ${account.address}, expected ${DEPLOYER_ADDRESS}`);
}

const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC) }) as EnsPublicClient;
const walletClient = createWalletClient({ account, chain: sepolia, transport: http(RPC) }) as EnsWalletClient;
const clients: EnsClients = { publicClient, walletClient };

const addresses: Record<string, Address> = deriveAddresses();
const allLabels: string[] = LABELS;

const LEDGER = "/home/ubuntu/projects/lisboa/deployments/ens-members-sepolia.json";

interface LedgerEntry {
  label: string;
  name: string;
  address: Address;
  salt: string;
  registry: Address;
  registerTx?: string | null;
  registryDeployTx?: string | null;
  setSubregistryTx?: string | null;
  setAddrTx?: string | null;
  verifiedAt?: string;
}

function readLedger(): Record<string, LedgerEntry> {
  if (!existsSync(LEDGER)) return {};
  const raw = JSON.parse(readFileSync(LEDGER, "utf8")) as { members?: Record<string, LedgerEntry> };
  return raw.members ?? {};
}

function writeLedger(members: Record<string, LedgerEntry>): void {
  writeFileSync(
    LEDGER,
    JSON.stringify(
      {
        network: "Ethereum Sepolia",
        chainId: 11155111,
        parentRegistry: VOUCHME_ETH_REGISTRY,
        resolver: VOUCHME_ETH_RESOLVER,
        deployer: DEPLOYER_ADDRESS,
        saltDerivation: `salt(label) = uint256(keccak256(utf8("${MEMBER_REGISTRY_SALT_NAMESPACE}::" + label)))`,
        addressDerivation:
          "outerSalt = keccak256(abi.encode(deployer, salt)); creation = 0x3d604d80600a3d3981f3 ‖ 0x363d3d373d3d3d363d73 ‖ proxyLogic ‖ 0x5af43d82803e903d91602b57fd5bf3 ‖ outerSalt; address = CREATE2(verifiableFactory, outerSalt, keccak256(creation))",
        generatedAt: new Date().toISOString(),
        members,
      },
      null,
      2,
    ) + "\n",
  );
}

/** A brand-new client, not the one that did the writing — the point is to read what the chain says,
 *  not what this process believes. */
function freshClient(): EnsPublicClient {
  return createPublicClient({ chain: sepolia, transport: http(RPC) }) as EnsPublicClient;
}

async function verify(label: string, expectAddr: Address, parent: Address = VOUCHME_ETH_REGISTRY, fqdn = `${label}.vouchme.eth`) {
  const c = freshClient();
  const sub = await c.readContract({ address: parent, abi: REGISTRY_ABI, functionName: "getSubregistry", args: [label] });
  const code = sub === ZERO_ADDRESS ? "0x" : ((await c.getCode({ address: sub })) ?? "0x");
  const addr = await c.readContract({ address: VOUCHME_ETH_RESOLVER, abi: RESOLVER_ABI, functionName: "addr", args: [namehash(fqdn)] });
  const owner = await c.readContract({ address: parent, abi: REGISTRY_ABI, functionName: "findOwner", args: [label] });
  const rolesOnRegistry =
    sub === ZERO_ADDRESS
      ? 0n
      : await c.readContract({ address: sub, abi: REGISTRY_ABI, functionName: "roles", args: [0n, DEPLOYER_ADDRESS] });
  const ok = addr.toLowerCase() === expectAddr.toLowerCase() && sub !== ZERO_ADDRESS && code.length > 2;
  console.log(
    `    verify ${fqdn.padEnd(28)} owner=${owner} addr=${addr} ${addr.toLowerCase() === expectAddr.toLowerCase() ? "OK" : "MISMATCH(expected " + expectAddr + ")"}`,
  );
  const soulbound = sub === ZERO_ADDRESS ? false : await isNameSoulbound(c, parent, label);
  console.log(
    `           subregistry=${sub} codeBytes=${(code.length - 2) / 2} rootRoles(deployer)=0x${rolesOnRegistry.toString(16)} ${
      rolesOnRegistry === SOULBOUND_ROLES ? "(SOULBOUND_ROLES)" : rolesOnRegistry === ALL_ROLES ? "(ALL_ROLES — TRANSFERABLE)" : ""
    } soulbound=${soulbound}`,
  );
  if (!ok) throw new Error(`verification FAILED for ${fqdn}`);
  return { sub, addr, code };
}

async function provision(label: string) {
  const target = addresses[label];
  if (!target) throw new Error(`no derived address for label "${label}"`);
  const salt = memberRegistrySalt(label);
  const predicted = predictMemberRegistryAddress(label);
  console.log(`\n── ${label}.vouchme.eth  →  ${target}`);
  console.log(`    salt      0x${salt.toString(16).padStart(64, "0")}`);
  console.log(`    registry  ${predicted} (deterministic)`);

  const result = await mintMemberName(clients, label, target);
  console.log(
    `    txs: deployProxy=${result.registryDeployTxHash ?? "-"} register=${result.registerTxHash ?? "-"} setSubregistry=${result.setSubregistryTxHash ?? "-"} setAddr=${result.setAddrTxHash ?? "-"}`,
  );
  if (result.subregistry?.toLowerCase() !== predicted.toLowerCase()) {
    throw new Error(`subregistry ${result.subregistry} != predicted ${predicted}`);
  }
  await verify(label, target);

  const members = readLedger();
  members[label] = {
    label,
    name: `${label}.vouchme.eth`,
    address: target,
    salt: `0x${salt.toString(16).padStart(64, "0")}`,
    registry: predicted,
    registerTx: result.registerTxHash,
    registryDeployTx: result.registryDeployTxHash,
    setSubregistryTx: result.setSubregistryTxHash,
    setAddrTx: result.setAddrTxHash,
    verifiedAt: new Date().toISOString(),
  };
  writeLedger(members);
  return result;
}

async function provisionVouch(voucher: string, vouchee: string) {
  const voucheeAddr = addresses[vouchee];
  if (!voucheeAddr) throw new Error(`no derived address for "${vouchee}"`);
  console.log(`\n── vouch ${voucher} → ${vouchee}   (${vouchee}.${voucher}.vouchme.eth)`);
  const r = await mintVouchSubname(clients, voucher, vouchee, voucheeAddr);
  console.log(
    `    txs: register=${r.registerTxHash ?? "-"} setSubregistry=${r.setSubregistryTxHash ?? "-"} setAddr=${r.setAddrTxHash ?? "-"}`,
  );
  console.log(`    voucherRegistry=${r.voucherRegistry}  voucheeRegistry=${r.voucheeRegistry}`);
  if (r.voucheeRegistryDeployTxHash || r.voucheeRegistryAttachTxHash) {
    console.log(`    vouchee registry backfilled: deployProxy=${r.voucheeRegistryDeployTxHash ?? "-"} setSubregistry=${r.voucheeRegistryAttachTxHash ?? "-"}`);
  }
  await verify(vouchee, voucheeAddr, r.voucherRegistry, r.name);
  return r;
}

/**
 * The resolver is node-keyed: registry traversal makes a deeper name like
 * `erin.carol.alice.vouchme.eth` structurally valid the moment each hop's subregistry exists, but the
 * leaf still needs its own `setAddr` before `addr()` returns anything. This writes exactly that one
 * record for an already-traversable name — it registers nothing.
 */
async function setAddrFor(fqdn: string, labelForAddress: string) {
  const target = addresses[labelForAddress];
  if (!target) throw new Error(`no derived address for "${labelForAddress}"`);
  const node = namehash(fqdn);
  const current = await publicClient.readContract({ address: VOUCHME_ETH_RESOLVER, abi: RESOLVER_ABI, functionName: "addr", args: [node] });
  if (current.toLowerCase() === target.toLowerCase()) {
    console.log(`\n── ${fqdn} already resolves to ${target} — nothing written.`);
    return;
  }
  const hash = await walletClient.writeContract({ address: VOUCHME_ETH_RESOLVER, abi: RESOLVER_ABI, functionName: "setAddr", args: [node, target] });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`setAddr(${fqdn}) reverted: ${hash}`);
  const readBack = await freshClient().readContract({ address: VOUCHME_ETH_RESOLVER, abi: RESOLVER_ABI, functionName: "addr", args: [node] });
  console.log(`\n── setAddr ${fqdn} -> ${target}\n    tx ${hash}\n    read back: ${readBack} ${readBack.toLowerCase() === target.toLowerCase() ? "OK" : "MISMATCH"}`);
  if (readBack.toLowerCase() !== target.toLowerCase()) throw new Error("read-back mismatch");
}

async function check() {
  const c = freshClient();
  for (const label of allLabels) {
    const owner = await c.readContract({ address: VOUCHME_ETH_REGISTRY, abi: REGISTRY_ABI, functionName: "findOwner", args: [label] });
    const sub = await getSubregistry(c, VOUCHME_ETH_REGISTRY, label);
    const code = sub === ZERO_ADDRESS ? "0x" : ((await c.getCode({ address: sub })) ?? "0x");
    const addr = await c.readContract({
      address: VOUCHME_ETH_RESOLVER,
      abi: RESOLVER_ABI,
      functionName: "addr",
      args: [namehash(`${label}.vouchme.eth`)],
    });
    const want = addresses[label];
    console.log(
      `${label.padEnd(9)} owner=${owner === ZERO_ADDRESS ? "NONE".padEnd(42) : owner} addr=${addr === ZERO_ADDRESS ? "NONE".padEnd(42) : addr}${want && addr.toLowerCase() === want.toLowerCase() ? " ✓" : want ? " ✗" : ""} sub=${sub === ZERO_ADDRESS ? "NONE".padEnd(42) : sub} code=${(code.length - 2) / 2}`,
    );
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const before = await publicClient.getBalance({ address: DEPLOYER_ADDRESS });
  console.log(`deployer ${DEPLOYER_ADDRESS} balance BEFORE: ${formatEther(before)} SepoliaETH`);

  if (argv.includes("--check")) {
    await check();
  } else if (argv.includes("--vouch")) {
    const i = argv.indexOf("--vouch");
    const voucher = argv[i + 1];
    const vouchee = argv[i + 2];
    if (!voucher || !vouchee) throw new Error("--vouch <voucher> <vouchee>");
    await provisionVouch(voucher, vouchee);
  } else if (argv.includes("--all")) {
    for (const label of allLabels) {
      await provision(label); // strictly sequential: each receipt awaited before the next nonce
    }
  } else if (argv.includes("--setaddr")) {
    const i = argv.indexOf("--setaddr");
    const fqdn = argv[i + 1];
    const label = argv[i + 2];
    if (!fqdn || !label) throw new Error("--setaddr <fqdn> <label-whose-address-to-use>");
    await setAddrFor(fqdn, label);
  } else if (argv.includes("--label")) {
    const label = argv[argv.indexOf("--label") + 1];
    if (!label) throw new Error("--label <label>");
    await provision(label);
  } else {
    console.log("usage: --check | --label <l> | --all | --vouch <voucher> <vouchee> | --setaddr <fqdn> <label>");
  }

  const after = await publicClient.getBalance({ address: DEPLOYER_ADDRESS });
  console.log(`\ndeployer balance AFTER:  ${formatEther(after)} SepoliaETH`);
  console.log(`spent this run:          ${formatEther(before - after)} SepoliaETH`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
