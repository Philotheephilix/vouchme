/**
 * app/src/lib/worldchain.ts
 *
 * Client-safe World Chain Sepolia config + ABI fragments for the transactions the connected
 * wallet signs directly (enroll, vouch, reaffirm, revoke, claim). This is the client-bundle
 * counterpart to `src/lib/chain.ts` (server-only, reads via a private RPC key path and does the
 * heavy Multicall3 graph scan). Nothing here holds a secret — chain id, RPC URL and contract
 * addresses are all public facts, read from `NEXT_PUBLIC_*` env vars so they survive into the
 * browser bundle on purpose.
 */

import { getAddress, type Address } from "viem";

/**
 * The chain VouchMe's contracts live on. MiniKit refuses to broadcast on anything but World Chain
 * mainnet (480) — @worldcoin/minikit-js 2.0.3's send-transaction path throws
 * `SendTransactionError("invalid_operation")` client-side for any other chain id, so the request
 * never reaches World App at all.
 *
 * Written as a literal `process.env.NEXT_PUBLIC_CHAIN_ID` member expression for the inlining
 * reason documented below; falls back to mainnet, because mainnet is the only value at which the
 * Mini App works at all.
 */
export const WORLDCHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "480");

const IS_MAINNET = WORLDCHAIN_ID === 480;

export const WORLDCHAIN = {
  id: WORLDCHAIN_ID,
  name: IS_MAINNET ? "World Chain" : "World Chain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: {
      http: [
        process.env.NEXT_PUBLIC_WORLDCHAIN_RPC ??
          (IS_MAINNET ? "https://worldchain-mainnet.g.alchemy.com/public" : "https://worldchain-sepolia.gateway.tenderly.co"),
      ],
    },
  },
  blockExplorers: {
    default: { name: "Worldscan", url: IS_MAINNET ? "https://worldscan.org" : "https://sepolia.worldscan.org" },
  },
} as const;

export class ClientConfigError extends Error {}

/**
 * Every `NEXT_PUBLIC_*` read in this file MUST be written as a literal member expression —
 * `process.env.NEXT_PUBLIC_FOO` — and never as `process.env[someVariable]`.
 *
 * Next.js inlines these values into the client bundle by statically substituting the literal
 * text at build time. A computed key cannot be analysed statically, so it is never substituted,
 * and the variable reads as `undefined` in the browser while working perfectly on the server —
 * a correctly-populated .env.local then looks like a missing one.
 *
 * Hence the shape below: callers pass the literal read in, and this helper only validates it.
 */
function parsePublicAddress(name: string, raw: string | undefined): Address {
  if (!raw) {
    throw new ClientConfigError(`${name} is not set in the client bundle — see app/.env.example.`);
  }
  try {
    return getAddress(raw);
  } catch {
    throw new ClientConfigError(`${name}="${raw}" is not a valid address.`);
  }
}

export function getVouchMeRegistryAddress(): Address {
  return parsePublicAddress(
    "NEXT_PUBLIC_VOUCHME_REGISTRY_ADDRESS",
    process.env.NEXT_PUBLIC_VOUCHME_REGISTRY_ADDRESS,
  );
}

export function getPresenceDripAddress(): Address {
  return parsePublicAddress(
    "NEXT_PUBLIC_PRESENCE_DRIP_ADDRESS",
    process.env.NEXT_PUBLIC_PRESENCE_DRIP_ADDRESS,
  );
}

export function getAppId(): string {
  const v = process.env.NEXT_PUBLIC_APP_ID;
  if (!v) throw new ClientConfigError("NEXT_PUBLIC_APP_ID is not set — see app/.env.example.");
  return v;
}

/** The nullifier namespace (docs/03-worldid.md §2). One action covers enrollment AND vouch presence
 *  proofs (docs/03-worldid.md §5.1); a separate `aval-vouch-v1` action must not be reintroduced. */
export function getWorldIdAction(): string {
  const v = process.env.NEXT_PUBLIC_WORLD_ID_ACTION;
  if (!v) throw new ClientConfigError("NEXT_PUBLIC_WORLD_ID_ACTION is not set — see app/.env.example.");
  return v;
}

export function explorerTxUrl(hash: string): string {
  return `${WORLDCHAIN.blockExplorers.default.url}/tx/${hash}`;
}

export function explorerAddressUrl(address: string): string {
  return `${WORLDCHAIN.blockExplorers.default.url}/address/${address}`;
}

/** ENSv2 minting (`src/lib/ens.ts`, server-only) happens on Ethereum Sepolia — a different chain
 *  from World Chain Sepolia above. Client-safe URL formatter only; kept here (not in ens.ts,
 *  which is `import "server-only"`) so client components can link to it without pulling a
 *  server-only module into the browser bundle. */
export function ensExplorerTxUrl(hash: string): string {
  return `https://sepolia.etherscan.io/tx/${hash}`;
}

// ─── ABI — exactly the write functions + errors the client needs (contracts/src/VouchMeRegistry.sol,
// contracts/src/PresenceDrip.sol). Read-only surfaces the client needs (isEnrolled, members) are
// included too, since a wallet-side pre-flight check is cheap and gives a better error than
// waiting for a revert. ──────────────────────────────────────────────────────────────────────────

export const VOUCHME_REGISTRY_ABI = [
  {
    type: "function",
    name: "enroll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "nullifierHash", type: "uint256" },
      { name: "credential", type: "bytes32" },
      { name: "handle", type: "string" },
      { name: "deadline", type: "uint64" },
      { name: "nonce", type: "uint256" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "vouch",
    stateMutability: "nonpayable",
    inputs: [
      { name: "vouchee", type: "address" },
      { name: "voucherTier", type: "uint8" },
      { name: "deadline", type: "uint64" },
      { name: "nonce", type: "uint256" },
      { name: "presenceAttestation", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "reaffirm",
    stateMutability: "nonpayable",
    inputs: [{ name: "vouchee", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "revoke",
    stateMutability: "nonpayable",
    inputs: [{ name: "vouchee", type: "address" }],
    outputs: [],
  },
  {
    type: "function",
    name: "isEnrolled",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "members",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "enrolledAt", type: "uint64" },
      { name: "credentialExpiresAt", type: "uint64" },
      { name: "activeOutbound", type: "uint32" },
      { name: "lastVouchAt", type: "uint64" },
      { name: "slotPenaltyUntil", type: "uint64" },
      { name: "slotPenaltyCount", type: "uint8" },
      { name: "enrolled", type: "bool" },
      { name: "fraudulent", type: "bool" },
    ],
  },
  // ─── errors — decoded from a reverted tx so the UI can surface the real reason, never a
  // generic failure (contracts/src/VouchMeRegistry.sol's `error` block, verbatim). ──────────────────
  { type: "error", name: "NotEnrolled", inputs: [] },
  { type: "error", name: "AlreadyEnrolled", inputs: [] },
  { type: "error", name: "NullifierUsed", inputs: [] },
  { type: "error", name: "BadAttestation", inputs: [] },
  { type: "error", name: "AttestationExpired", inputs: [] },
  { type: "error", name: "AttestationReplayed", inputs: [] },
  { type: "error", name: "NoSlots", inputs: [] },
  { type: "error", name: "RateLimited", inputs: [] },
  { type: "error", name: "SelfVouch", inputs: [] },
  { type: "error", name: "VouchExists", inputs: [] },
  { type: "error", name: "NoSuchVouch", inputs: [] },
  { type: "error", name: "CredentialExpired", inputs: [] },
  { type: "error", name: "InsufficientTier", inputs: [] },
  { type: "error", name: "Suspended", inputs: [] },
  { type: "error", name: "NotGovernor", inputs: [] },
  { type: "error", name: "ZeroAddress", inputs: [] },
  { type: "error", name: "NotReportRegistry", inputs: [] },
  { type: "error", name: "AlreadyPlatform", inputs: [] },
] as const;

export const PRESENCE_DRIP_ABI = [
  {
    type: "function",
    name: "claim",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tier", type: "uint8" },
      { name: "deadline", type: "uint64" },
      { name: "nonce", type: "uint256" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "accrued",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  { type: "error", name: "NotEnrolled", inputs: [] },
  { type: "error", name: "NothingToClaim", inputs: [] },
  { type: "error", name: "BadAttestation", inputs: [] },
  { type: "error", name: "AttestationExpired", inputs: [] },
  { type: "error", name: "AttestationReplayed", inputs: [] },
] as const;

/** Every distinct error name across both ABIs, for a single `decodeErrorResult` attempt against
 *  whichever contract reverted. */
export const KNOWN_ERRORS_ABI = [
  ...VOUCHME_REGISTRY_ABI.filter((f) => f.type === "error"),
  ...PRESENCE_DRIP_ABI.filter((f) => f.type === "error" && !VOUCHME_REGISTRY_ABI.some((g) => g.type === "error" && g.name === f.name)),
] as const;
