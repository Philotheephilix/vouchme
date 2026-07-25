/**
 * scripts/dev/provision-vouchme-parent.mts
 *
 * Give `vouchme.eth` its own PermissionedRegistry, so it can hold member subnames the way
 * `aval.eth` does.
 *
 * `vouchme.eth` is registered and owned by the deployer, but its `Entry.subregistry` on the `.eth`
 * registry is the zero address — a name with no registry cannot have children at all, which is the
 * same structural gap that made vouch subnames impossible under `aval.eth` before it was fixed.
 *
 * Three steps, each verified by reading the chain back rather than trusting a receipt:
 *   1. deploy a registry clone through the VerifiableFactory (CREATE2, salt derived from the label,
 *      so the address is re-derivable offline and a re-run is idempotent);
 *   2. `setSubregistry("vouchme", clone)` on the `.eth` registry;
 *   3. clear ROLE_CAN_TRANSFER_ADMIN on the clone's ROOT_RESOURCE, so every name minted under it is
 *      soulbound from its first block.
 *
 * Run:  npx tsx scripts/dev/provision-vouchme-parent.mts
 */
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { readFileSync } from "node:fs";
import {
  ensureRegistrySoulbound,
  hasContractCode,
  predictMemberRegistryAddress,
  memberRegistrySalt,
  REGISTRY_ABI,
  REGISTRY_INITIALIZER_ABI,
  SOULBOUND_ROLES,
  VERIFIABLE_FACTORY,
  VERIFIABLE_FACTORY_ABI,
  MEMBER_REGISTRY_IMPLEMENTATION,
  ZERO_ADDRESS,
  type EnsClients,
} from "../../app/src/lib/ens-core.js";

const LABEL = "vouchme";
/** ENSv2 `.eth` registry — the parent of every second-level name. */
const ETH_REGISTRY: Address = "0xDEDB92913A25abE1f7BCDD85D8A344a43B398B67";

function env(name: string): string {
  const raw = readFileSync("app/.env.local", "utf8");
  for (const line of raw.split("\n")) {
    if (!line.includes("=") || line.trim().startsWith("#")) continue;
    const k = line.slice(0, line.indexOf("=")).trim();
    if (k === name) return line.slice(line.indexOf("=") + 1).trim();
  }
  throw new Error(`${name} not set in app/.env.local`);
}

const rpc = env("ETH_SEPOLIA_RPC");
const pk = env("DEPLOYER_PRIVATE_KEY");
const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);

const publicClient = createPublicClient({ chain: sepolia, transport: http(rpc) });
const walletClient = createWalletClient({ account, chain: sepolia, transport: http(rpc) });
const clients = { publicClient, walletClient } as unknown as EnsClients;

async function main(): Promise<void> {
  console.log(`deployer   ${account.address}`);

  const owner = (await publicClient.readContract({
    address: ETH_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "findOwner",
    args: [LABEL],
  })) as Address;
  if (owner.toLowerCase() !== account.address.toLowerCase()) {
    throw new Error(`${LABEL}.eth is owned by ${owner}, not the deployer — refusing to touch it.`);
  }
  console.log(`${LABEL}.eth owner OK`);

  // ── 1. the registry clone ────────────────────────────────────────────────────────────────────
  const predicted = predictMemberRegistryAddress(LABEL, account.address);
  let deployTx: Hex | null = null;
  if (await hasContractCode(publicClient, predicted)) {
    console.log(`registry   ${predicted} already deployed`);
  } else {
    const initData = encodeFunctionData({
      abi: REGISTRY_INITIALIZER_ABI,
      functionName: "initialize",
      args: [account.address, SOULBOUND_ROLES],
    });
    deployTx = await walletClient.writeContract({
      address: VERIFIABLE_FACTORY,
      abi: VERIFIABLE_FACTORY_ABI,
      functionName: "deployProxy",
      args: [MEMBER_REGISTRY_IMPLEMENTATION, memberRegistrySalt(LABEL), initData],
    });
    const r = await publicClient.waitForTransactionReceipt({ hash: deployTx });
    if (r.status !== "success") throw new Error(`deployProxy reverted: ${deployTx}`);
    console.log(`registry   ${predicted} deployed  ${deployTx}`);
  }

  // ── 2. attach it to the .eth entry ───────────────────────────────────────────────────────────
  const current = (await publicClient.readContract({
    address: ETH_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "getSubregistry",
    args: [LABEL],
  })) as Address;

  let attachTx: Hex | null = null;
  if (current.toLowerCase() === predicted.toLowerCase()) {
    console.log(`subregistry already attached`);
  } else if (current !== ZERO_ADDRESS) {
    throw new Error(`${LABEL}.eth already points at ${current}, not ${predicted} — refusing to overwrite.`);
  } else {
    // `setSubregistry` takes a tokenId; the registry resolves the label's own entry from it.
    const tokenId = (await publicClient.readContract({
      address: ETH_REGISTRY,
      abi: REGISTRY_ABI,
      functionName: "findTokenId",
      args: [LABEL],
    })) as bigint;
    attachTx = await walletClient.writeContract({
      address: ETH_REGISTRY,
      abi: REGISTRY_ABI,
      functionName: "setSubregistry",
      args: [tokenId, predicted],
    });
    const r = await publicClient.waitForTransactionReceipt({ hash: attachTx });
    if (r.status !== "success") throw new Error(`setSubregistry reverted: ${attachTx}`);
    console.log(`subregistry attached  ${attachTx}`);
  }

  // ── 3. soulbound ─────────────────────────────────────────────────────────────────────────────
  const soulboundTx = await ensureRegistrySoulbound(clients, predicted);
  console.log(`soulbound  ${soulboundTx ?? "already clear"}`);

  // ── verify by reading back, not from receipts ────────────────────────────────────────────────
  const finalSub = (await publicClient.readContract({
    address: ETH_REGISTRY,
    abi: REGISTRY_ABI,
    functionName: "getSubregistry",
    args: [LABEL],
  })) as Address;
  const code = ((await publicClient.getBytecode({ address: finalSub })) ?? "0x").length / 2 - 1;
  console.log(`\nVERIFY  ${LABEL}.eth -> ${finalSub}  code=${code}B  match=${finalSub.toLowerCase() === predicted.toLowerCase()}`);
}

main().catch((e) => {
  console.error(String(e).slice(0, 400));
  process.exit(1);
});
