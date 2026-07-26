import "server-only";

import { createPublicClient, createWalletClient, getAddress, http, keccak256, toHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Lend's identity as a REGISTERED PLATFORM in VouchMe, and the two on-chain writes a report needs.
 *
 * A platform report is not a form submission — it is `ReportRegistry.file()` from Lend's own key,
 * bonded with Lend's own slashable VOUCHME. Four prerequisites hold, all established on chain by
 * `scripts/seed-lendme-platform.mjs`:
 *
 *   1. Lend is registered in `PlatformRegistry` with a 5 000 VOUCHME bond.
 *   2. Lend's platform tier is >= P1 (40.00), reached by eight humans vouching for it. The engine
 *      recomputes this from the graph, so it cannot be asserted — only earned.
 *   3. The attestor key is allow-listed on `ReportRegistry`, so VouchMe's signature is accepted.
 *   4. Lend holds a bonded position in `CredibilityVault`, because `lockForReport` locks the bond
 *      out of `bonded - locked` and never pulls tokens at filing time.
 *
 * WHAT THIS KEY CAN DO, stated plainly: spend Lend's bond on an accusation. A report that a jury
 * finds MALICIOUS slashes that bond and voids Lend as a reporter permanently. It is a treasury key
 * by another name, and it is why `/api/report` refuses to file for anyone without a session.
 */

export class PlatformConfigError extends Error {}

const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "480");

function chain() {
  const rpc = process.env.WORLDCHAIN_RPC;
  if (!rpc) throw new PlatformConfigError("WORLDCHAIN_RPC is not set, so nothing can be read from or written to World Chain.");
  return {
    id: CHAIN_ID,
    name: CHAIN_ID === 480 ? "World Chain" : "World Chain Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  } as const;
}

const platformRegistryAbi = [
  { type: "function", name: "requestScore", inputs: [{ type: "address" }, { type: "bytes32" }], outputs: [{ type: "bytes32" }], stateMutability: "nonpayable" },
  { type: "function", name: "scoreRequests", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }], stateMutability: "view" },
  { type: "function", name: "isRegistered", inputs: [{ type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
] as const;

const reportRegistryAbi = [
  {
    type: "function",
    name: "file",
    inputs: [
      { type: "address", name: "target" },
      { type: "bytes32", name: "evidenceHash" },
      { type: "uint32", name: "weightPoints" },
      { type: "uint64", name: "deadline" },
      { type: "uint256", name: "nonce" },
      { type: "bytes", name: "attestation" },
    ],
    outputs: [{ type: "bytes32" }],
    stateMutability: "nonpayable",
  },
] as const;

interface Platform {
  account: ReturnType<typeof privateKeyToAccount>;
  publicClient: PublicClient;
  walletClient: ReturnType<typeof createWalletClient>;
  platformRegistry: Address;
}

let cached: Platform | null = null;

function getPlatform(): Platform | null {
  if (cached) return cached;
  const key = process.env.LEND_PLATFORM_PRIVATE_KEY?.trim();
  if (!key) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new PlatformConfigError("LEND_PLATFORM_PRIVATE_KEY is set but is not a 0x-prefixed 32-byte hex private key.");
  }
  const registry = process.env.LEND_PLATFORM_REGISTRY_ADDRESS?.trim();
  if (!registry) {
    throw new PlatformConfigError("LEND_PLATFORM_REGISTRY_ADDRESS is not set, so no ScoreRequest can be recorded and no report can be filed.");
  }
  const c = chain();
  const transport = http(c.rpcUrls.default.http[0]);
  const account = privateKeyToAccount(key as Hex);
  cached = {
    account,
    publicClient: createPublicClient({ chain: c, transport }) as PublicClient,
    walletClient: createWalletClient({ account, chain: c, transport }),
    // Lower-cased before checksumming: the deployment records these addresses without EIP-55
    // casing, and viem rejects a mis-cased address outright.
    platformRegistry: getAddress(registry.toLowerCase()),
  };
  return cached;
}

export function reportingConfigured(): boolean {
  try {
    return getPlatform() !== null;
  } catch {
    return false;
  }
}

export function platformAddress(): Address | null {
  try {
    return getPlatform()?.account.address ?? null;
  } catch {
    return null;
  }
}

/** True once Lend is an active platform on chain. Read live rather than assumed, because losing
 *  registration (or pointing at the wrong deployment) turns every report into a bare revert. */
export async function platformRegistered(): Promise<boolean> {
  const p = getPlatform();
  if (!p) return false;
  return p.publicClient.readContract({
    address: p.platformRegistry,
    abi: platformRegistryAbi,
    functionName: "isRegistered",
    args: [p.account.address],
  });
}

/**
 * Record the attributed `ScoreRequest` that entitles Lend to report this subject at all.
 *
 * docs/12-reporting.md §2: "A platform cannot report a person it never looked up. The transparency
 * log is load-bearing, not decorative." This is that log entry — public, attributable, and on
 * chain. `ReportRegistry.file()` reverts with `NoScoreRequest()` without it.
 *
 * Skipped when already recorded: the mapping is keyed by (platform, subject) and never expires, so
 * re-requesting would only spend gas to set a bit that is already set.
 */
export async function ensureScoreRequest(subject: Address, purpose: string): Promise<{ txHash: Hex | null }> {
  const p = getPlatform();
  if (!p) throw new PlatformConfigError("Reporting is not configured.");

  const key = keccak256(
    // keccak256(abi.encode(platform, subject)) — matches PlatformRegistry's own `reqKey`.
    `0x${p.account.address.slice(2).toLowerCase().padStart(64, "0")}${subject.slice(2).toLowerCase().padStart(64, "0")}` as Hex,
  );
  const already = await p.publicClient.readContract({
    address: p.platformRegistry,
    abi: platformRegistryAbi,
    functionName: "scoreRequests",
    args: [key],
  });
  if (already) return { txHash: null };

  const txHash = await p.walletClient.writeContract({
    address: p.platformRegistry,
    abi: platformRegistryAbi,
    functionName: "requestScore",
    args: [subject, keccak256(toHex(purpose))],
    chain: chain(),
    account: p.account,
  });
  // Awaited deliberately. VouchMe's attestation route checks this same mapping over live chain
  // state, and asking it before the transaction is mined gets a `no_score_request` refusal for a
  // request that is already in flight.
  await p.publicClient.waitForTransactionReceipt({ hash: txHash });
  return { txHash };
}

export interface FileReportInput {
  target: Address;
  evidenceHash: Hex;
  weightPoints: number;
  deadline: bigint;
  nonce: bigint;
  attestation: Hex;
  reportRegistry: Address;
}

/**
 * File the report on chain.
 *
 * The registry address comes from VouchMe's attestation response rather than from Lend's own env:
 * the attestation is bound to one registry's domain separator, so a second copy of that address
 * here could drift out of step and produce `BadAttestation` with nothing to explain why.
 */
export async function fileReport(input: FileReportInput): Promise<Hex> {
  const p = getPlatform();
  if (!p) throw new PlatformConfigError("Reporting is not configured.");
  return p.walletClient.writeContract({
    address: getAddress(input.reportRegistry.toLowerCase()),
    abi: reportRegistryAbi,
    functionName: "file",
    args: [input.target, input.evidenceHash, input.weightPoints, input.deadline, input.nonce, input.attestation],
    chain: chain(),
    account: p.account,
  });
}
