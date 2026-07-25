/**
 * app/src/lib/ens.ts
 *
 * Server-only, environment-bound wrapper around `ens-core.ts` — real ENSv2 minting for
 * `<handle>.aval.eth` on Ethereum Sepolia (chainId 11155111), a DIFFERENT chain from AvalRegistry
 * (World Chain Sepolia, 4801). docs/04-ens.md §7: "a member = a PermissionedRegistry they own" —
 * in this design the name is not a label attached to an account, the name *is* the record, and the
 * member owns the registry that issues their vouches.
 *
 * All contract addresses, ABIs and the write sequences live in `ens-core.ts` so the operational
 * scripts (`scripts/dev/ens-provision.mts`) execute the identical code path as the app. This file
 * adds only the two things a script supplies for itself: the RPC URL and the signing key.
 *
 * `DEPLOYER_PRIVATE_KEY` (== `PRIVATE_KEY` in this deployment's `.env`) holds `ALL_ROLES` on the
 * aval.eth registry clone, so it can `register()` new subnames and deploy member registries.
 * Server-only: this key must never reach the client bundle.
 */

import "server-only";

import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

import {
  AVAL_ETH_REGISTRY,
  DEPLOYER_ADDRESS,
  EnsConfigError,
  ZERO_ADDRESS,
  findOwner,
  getSubregistry,
  hasContractCode,
  mintMemberName,
  mintVouchSubname,
  predictMemberRegistryAddress,
  readAddrRecord,
  type EnsClients,
  type EnsPublicClient,
  type EnsWalletClient,
  type MintResult,
  type VouchMintResult,
} from "./ens-core";

export {
  EnsConfigError,
  EnsMintPartialError,
  EnsVouchNestingUnavailableError,
  predictMemberRegistryAddress,
  AVAL_ETH_REGISTRY,
  AVAL_ETH_RESOLVER,
} from "./ens-core";
export type { MintResult, VouchMintResult } from "./ens-core";

function getDeployerAccount() {
  const key = process.env.DEPLOYER_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!key) {
    throw new EnsConfigError("DEPLOYER_PRIVATE_KEY (or PRIVATE_KEY) is not set — cannot mint ENS subnames.");
  }
  const account = privateKeyToAccount(key as Hex);
  if (account.address.toLowerCase() !== DEPLOYER_ADDRESS.toLowerCase()) {
    throw new EnsConfigError(
      `Configured deployer key derives to ${account.address}, not the expected aval.eth registry owner ${DEPLOYER_ADDRESS}. Refusing to mint with an unverified key.`,
    );
  }
  return account;
}

function getRpcUrl(): string {
  const url = process.env.ETH_SEPOLIA_RPC;
  if (!url) throw new EnsConfigError("ETH_SEPOLIA_RPC is not set — cannot reach Ethereum Sepolia for ENS.");
  return url;
}

let cachedPublicClient: EnsPublicClient | null = null;
function getPublicClient(): EnsPublicClient {
  if (!cachedPublicClient) {
    cachedPublicClient = createPublicClient({ chain: sepolia, transport: http(getRpcUrl()) }) as EnsPublicClient;
  }
  return cachedPublicClient;
}

function getClients(): EnsClients {
  const walletClient = createWalletClient({
    account: getDeployerAccount(),
    chain: sepolia,
    transport: http(getRpcUrl()),
  }) as EnsWalletClient;
  return { publicClient: getPublicClient(), walletClient };
}

/** `findOwner(label) == address(0)` — the live, on-chain availability check (not a cache, not a
 *  guess), against the same registry docs/04-ens.md §7.1 describes minting into. */
export async function isEnsLabelAvailable(label: string): Promise<boolean> {
  return (await findOwner(getPublicClient(), AVAL_ETH_REGISTRY, label)) === ZERO_ADDRESS;
}

/** Reads back what `<label>.aval.eth` actually resolves to right now — used both by the mint route
 *  (to confirm the write really took, not just that the tx didn't revert) and by
 *  `/api/ens/resolve` for independent verification. */
export async function resolveEnsLabel(label: string): Promise<Address | null> {
  return readAddrRecord(getPublicClient(), `${label}.aval.eth`);
}

/** The member's own `PermissionedRegistry` — `null` when they don't have one, which is exactly
 *  when nested vouch names are impossible for them. */
export async function getMemberRegistry(label: string): Promise<Address | null> {
  const client = getPublicClient();
  const registry = await getSubregistry(client, AVAL_ETH_REGISTRY, label);
  return (await hasContractCode(client, registry)) ? registry : null;
}

/**
 * Mints `<label>.aval.eth`, gives it its own registry, and points it at `targetAddress`.
 * Idempotent and resumable against live chain state (not a local flag) on every call — see
 * `mintMemberName` in `ens-core.ts` for the exact sequence and the read-backs that gate it.
 */
export async function mintEnsSubname(label: string, targetAddress: Address): Promise<MintResult> {
  return mintMemberName(getClients(), label, targetAddress);
}

/**
 * Mints `<voucheeLabel>.<voucherLabel>.aval.eth` inside the VOUCHER's own registry — the vouch as
 * a name. Throws `EnsVouchNestingUnavailableError` if the voucher has no registry yet; callers
 * must surface that plainly rather than report a mint that did not happen.
 */
export async function mintEnsVouchSubname(
  voucherLabel: string,
  voucheeLabel: string,
  voucheeAddress: Address,
): Promise<VouchMintResult> {
  return mintVouchSubname(getClients(), voucherLabel, voucheeLabel, voucheeAddress);
}
