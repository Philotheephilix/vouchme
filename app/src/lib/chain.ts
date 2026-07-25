/**
 * app/src/lib/chain.ts
 *
 * The live data source: World Chain Sepolia, read directly with viem. No subgraph, no indexer —
 * this reads `Enrolled` / `Vouched` / `Reaffirmed` / `Revoked` logs from `AvalRegistry` straight
 * off the chain, resolves anchor status live from the Address Book's `addressVerifiedUntil` (never
 * cached into the scoring path — docs/03-worldid.md §3), and reads presence-drip state from
 * `PresenceDrip`. It assembles the exact `EngineInput` shape `@aval/engine` expects and hands the
 * caller that input plus the real `EngineOutput` from `compute()` — this module never formats a
 * score itself. Every number still comes from the engine (docs/01-trust-math.md).
 *
 * Server-only. Never imported from a "use client" component.
 */

import {
  createPublicClient,
  fallback,
  getAddress,
  http,
  type AbiEvent,
  type Address,
  type Chain,
  type Log,
  type PublicClient,
} from "viem";
import { compute, type Account, type EngineInput, type EngineOutput, type Vouch } from "@aval/engine";

// ─── World Chain ──────────────────────────────────────────────────────────────────────────────
// Which World Chain this is, is a DEPLOYMENT fact, not a fixed property of the code: Aval runs on
// mainnet (480) because MiniKit will not broadcast anywhere else, and the Sepolia deployment
// (4801) still exists and still holds the proven trust-math scenario. Hardcoding either one here
// silently pointed the whole data layer at the wrong chain.
export const WORLDCHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "480");

const worldChain = (rpcUrls: string[]): Chain => ({
  id: WORLDCHAIN_ID,
  name: WORLDCHAIN_ID === 480 ? "World Chain" : "World Chain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: rpcUrls } },
  contracts: {
    // Required for the client's multicall batching to have somewhere to aggregate into —
    // without this entry viem silently falls back to one HTTP request per read.
    // Canonical Multicall3 address; deployed at the same address on both World Chain networks,
    // verified on chain rather than assumed from it being an OP-stack chain.
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});

// ─── config, from env only — see app/.env.example for what each variable means. Deployment facts
// (addresses, deploy block) are copied verbatim from deployments/worldchain-sepolia.json, the
// authoritative record, not retyped from anywhere else. ─────────────────────────────────────────

export type ChainMode = "live" | "fixture";

export function getChainMode(): ChainMode {
  return process.env.NEXT_PUBLIC_CHAIN_MODE === "live" ? "live" : "fixture";
}

interface ChainConfig {
  /** Ordered, deduped; index 0 is primary, the rest are failover targets. */
  rpcUrls: string[];
  deploymentBlock: bigint;
  avalRegistry: Address;
  genesisAnchorBook: Address;
  presenceDrip: Address;
  meAddress: Address;
}

class ChainConfigError extends Error {}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new ChainConfigError(
      `NEXT_PUBLIC_CHAIN_MODE=live but ${name} is not set. Live mode reads World Chain Sepolia ` +
        `directly and refuses to guess — see app/.env.example.`,
    );
  }
  return v;
}

/** Accepts either name — `NEXT_PUBLIC_WORLDCHAIN_RPC` (this app's existing convention, see
 *  app/.env.example's pre-existing `NEXT_PUBLIC_WORLDCHAIN_RPC`) or `WORLDCHAIN_SEPOLIA_RPC`
 *  (the name every script under scripts/ and contracts/.env uses) — so one RPC URL value works
 *  everywhere in the repo without duplicating it under two unrelated names. */
/** Every distinct URL among `names`, in order — NOT just the first one that happens to be set.
 *  These become a viem `fallback()` transport, so a provider that rate-limits under the burst of
 *  reads one page issues is routed around instead of failing the request. Returning a single URL
 *  here (the previous behaviour) made `NEXT_PUBLIC_WORLDCHAIN_RPC_FALLBACK` dead config: it sat
 *  last in the list and was only ever reached if no other name was set, which never happened. */
function requireEnvAll(names: string[]): string[] {
  const urls: string[] = [];
  for (const name of names) {
    const v = process.env[name];
    if (v && !urls.includes(v)) urls.push(v);
  }
  if (urls.length > 0) return urls;
  throw new ChainConfigError(
    `NEXT_PUBLIC_CHAIN_MODE=live but none of [${names.join(", ")}] is set. Live mode reads World ` +
      `Chain Sepolia directly and refuses to guess — see app/.env.example.`,
  );
}

function requireAddress(name: string): Address {
  const raw = requireEnv(name);
  try {
    return getAddress(raw);
  } catch {
    throw new ChainConfigError(`${name}="${raw}" is not a valid address.`);
  }
}

let cachedConfig: ChainConfig | null = null;

function getConfig(): ChainConfig {
  if (cachedConfig) return cachedConfig;
  cachedConfig = {
    rpcUrls: requireEnvAll([
      "NEXT_PUBLIC_WORLDCHAIN_RPC",
      "WORLDCHAIN_RPC",
      "WORLDCHAIN_SEPOLIA_RPC",
      "NEXT_PUBLIC_WORLDCHAIN_RPC_FALLBACK",
    ]),
    deploymentBlock: BigInt(requireEnv("DEPLOYMENT_BLOCK")),
    avalRegistry: requireAddress("AVAL_REGISTRY_ADDRESS"),
    genesisAnchorBook: requireAddress("GENESIS_ANCHOR_BOOK_ADDRESS"),
    presenceDrip: requireAddress("PRESENCE_DRIP_ADDRESS"),
    meAddress: requireAddress("ME_ADDRESS"),
  };
  return cachedConfig;
}

/** Every contract address in play, for the `meta.contracts` envelope (requirement #3). Includes
 *  the ones this module doesn't read from (ReportRegistry, PlatformRegistry, CredibilityVault,
 *  AvalToken) so `meta` documents the full deployed set, not just the subset queried. */
export function getContractAddressSet(): Record<string, string> {
  const cfg = getConfig();
  const optional = (name: string): string | undefined => {
    const v = process.env[name];
    return v ? v : undefined;
  };
  const set: Record<string, string> = {
    AvalRegistry: cfg.avalRegistry,
    GenesisAnchorBook: cfg.genesisAnchorBook,
    PresenceDrip: cfg.presenceDrip,
  };
  const reportRegistry = optional("REPORT_REGISTRY_ADDRESS");
  const platformRegistry = optional("PLATFORM_REGISTRY_ADDRESS");
  const credibilityVault = optional("CREDIBILITY_VAULT_ADDRESS");
  const avalToken = optional("AVAL_TOKEN_ADDRESS");
  if (reportRegistry) set.ReportRegistry = reportRegistry;
  if (platformRegistry) set.PlatformRegistry = platformRegistry;
  if (credibilityVault) set.CredibilityVault = credibilityVault;
  if (avalToken) set.AvalToken = avalToken;
  return set;
}

/** NOT "me" — `ME_ADDRESS` is a technical fallback identity `buildLiveContext` needs to seed a
 *  graph context for pages that have no per-viewer concept at all (Explore, Platform), never
 *  a stand-in for a signed-in user. Every page that shows "your" data (Home, the enroll/vouch
 *  wizards) always passes a real, cookie-sourced `viewingAddress` instead — see `AppGate` and
 *  `page.tsx`'s own doc comment. Renamed from `getMeAddress` after the "why is it showing
 *  carol.aval.eth" bug, which was exactly this function's old name being taken literally. */
export function getDemoAddress(): Address {
  return getConfig().meAddress;
}

/** Server-only accessors for the two addresses `src/lib/attestation.ts` needs to build EIP-712
 *  domains for (AvalRegistry, PresenceDrip). Kept alongside the rest of `getConfig()`'s callers
 *  rather than re-reading `process.env` a second time. */
export function getAvalRegistryAddressServer(): Address {
  return getConfig().avalRegistry;
}

export function getPresenceDripAddressServer(): Address {
  return getConfig().presenceDrip;
}

// anchorSource() is declared `pure` on GenesisAnchorBook — it returns a compile-time constant and
// can never change for a given deployment. Re-reading it on every graph fetch was a wasted RPC
// round trip on a value that is, by construction, immutable. Fetch once per process.
let cachedAnchorSource: LiveAnchorSource | null = null;

async function getAnchorSource(client: PublicClient, book: Address): Promise<LiveAnchorSource> {
  if (cachedAnchorSource !== null) return cachedAnchorSource;
  // Decided by WHICH contract is configured, not by whether a call happened to fail. The real
  // Address Book has no anchorSource(), so asking it would revert — but a revert alone must never
  // be read as "these are Orb anchors."
  if (isWorldIdAddressBook(book)) {
    cachedAnchorSource = "world-id-orb";
    return cachedAnchorSource;
  }
  cachedAnchorSource = assertKnownAnchorSource(
    await client.readContract({
      address: book,
      abi: GENESIS_ANCHOR_BOOK_ABI,
      functionName: "anchorSource",
    }),
  );
  return cachedAnchorSource;
}

let cachedClient: PublicClient | null = null;

function getClient(): PublicClient {
  if (cachedClient) return cachedClient;
  const cfg = getConfig();
  cachedClient = createPublicClient({
    chain: worldChain(cfg.rpcUrls),
    // Aggregate concurrent eth_calls into Multicall3 instead of firing one request per account.
    //
    // Without this, each fetch issued roughly 3N+1 separate eth_calls — getIsUserVerified,
    // members() and the presence tuple, once per account, plus anchorSource() — which at 14
    // accounts is ~43 requests per uncached load and trips a public RPC's rate limit
    // immediately ("Request exceeds defined limit" from the gateway). Reading anchors live is a
    // correctness requirement (docs/03-worldid.md §3); reading them one HTTP request at a time
    // never was. Multicall3 keeps the reads live and at a single block, while collapsing them
    // into one or two requests.
    //
    // Multicall3 is at the canonical address on World Chain Sepolia — verified on chain, 7618
    // bytes of code, not assumed from it being an OP-stack chain.
    batch: {
      multicall: { batchSize: 1024, wait: 16 },
    },
    // Public RPCs rate-limit (429) under load — retry with backoff instead of surfacing a
    // transient throttle as "the chain is broken." A sustained outage still surfaces: retries
    // are bounded, and getLiveGraph()/getChainHealth() let a final failure propagate as a real
    // error rather than falling back to fixtures.
    // `fallback` over every configured URL, not just the first. Measured on 2026-07-25: a burst of
    // 48 concurrent eth_blockNumber calls returned 40/48 on the Tenderly gateway (8 × HTTP 429)
    // and 48/48 on Alchemy. Those empty-bodied 429s surfaced in the UI as
    // "Cannot read properties of undefined (reading 'error')" and as `chain_unavailable`, because
    // a throttled provider was the only provider. Retries alone can't fix that — the next attempt
    // hits the same rate-limited host. `rank: false` keeps declared order (env order is intent).
    transport: fallback(
      cfg.rpcUrls.map((url) => http(url, { retryCount: 3, retryDelay: 750, batch: true })),
      { rank: false, retryCount: 2 },
    ),
  });
  return cachedClient;
}

// ─── ABI fragments — exactly the surface this module reads, matching subgraph/abis/AvalRegistry
// .json for events and the Solidity source (contracts/src/*.sol) for the view functions. Events
// are also declared standalone (typed as `AbiEvent`) so `getLogs` can take them directly, without
// an `abi.find(...)` at runtime that TypeScript can't narrow. ────────────────────────────────────

const ENROLLED_EVENT = {
  type: "event",
  name: "Enrolled",
  anonymous: false,
  inputs: [
    { name: "account", type: "address", indexed: true },
    { name: "nullifierHash", type: "uint256", indexed: true },
    { name: "credential", type: "bytes32", indexed: false },
    { name: "credentialExpiresAt", type: "uint64", indexed: false },
    { name: "handle", type: "string", indexed: false },
  ],
} as const satisfies AbiEvent;

const VOUCHED_EVENT = {
  type: "event",
  name: "Vouched",
  anonymous: false,
  inputs: [
    { name: "voucher", type: "address", indexed: true },
    { name: "vouchee", type: "address", indexed: true },
    { name: "issuedAt", type: "uint64", indexed: false },
    { name: "expiresAt", type: "uint64", indexed: false },
  ],
} as const satisfies AbiEvent;

const REAFFIRMED_EVENT = {
  type: "event",
  name: "Reaffirmed",
  anonymous: false,
  inputs: [
    { name: "voucher", type: "address", indexed: true },
    { name: "vouchee", type: "address", indexed: true },
    { name: "expiresAt", type: "uint64", indexed: false },
  ],
} as const satisfies AbiEvent;

const REVOKED_EVENT = {
  type: "event",
  name: "Revoked",
  anonymous: false,
  inputs: [
    { name: "voucher", type: "address", indexed: true },
    { name: "vouchee", type: "address", indexed: true },
    { name: "at", type: "uint64", indexed: false },
  ],
} as const satisfies AbiEvent;

const AVAL_REGISTRY_ABI = [
  ENROLLED_EVENT,
  VOUCHED_EVENT,
  REAFFIRMED_EVENT,
  REVOKED_EVENT,
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
] as const;

const GENESIS_ANCHOR_BOOK_ABI = [
  {
    // Errata E-18: the real World ID Address Book has NO `getIsUserVerified` — that call reverts.
    // It stores an EXPIRY (`addressVerifiedUntil`), because Orb verification lapses unless renewed.
    // Both the contracts and the testnet stand-in now match this real shape.
    type: "function",
    name: "addressVerifiedUntil",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "anchorSource",
    stateMutability: "pure",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
] as const;

const PRESENCE_DRIP_ABI = [
  {
    type: "function",
    name: "presence",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "lastClaimAt", type: "uint64" },
      { name: "epochsClaimed", type: "uint64" },
      { name: "accrualPausedUntil", type: "uint64" },
    ],
  },
  {
    type: "function",
    name: "accrued",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** GenesisAnchorBook is honest by contract design (contracts/script/GenesisAnchorBook.sol's own
 *  doc comment): `anchorSource()` returns "genesis-testnet", never "world-id-orb". This module
 *  reads that value live rather than assuming it, and refuses to guess a label if it's ever
 *  anything else — presenting a genesis anchor as an Orb anchor would forge the one
 *  externally-grounded fact in the protocol. */
export type LiveAnchorSource = "genesis-testnet" | "world-id-orb";

/** World ID's real Address Book. It exists on World Chain MAINNET only — which is the entire
 *  reason `GenesisAnchorBook` was written as a testnet stand-in. Verified live before the mainnet
 *  deployment: 3095 bytes of code at chain 480 (deployments/worldchain-mainnet.json). */
const WORLD_ID_ADDRESS_BOOK: Address = "0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D";

/** Anchors are the one externally-grounded fact in the protocol, so how they are labelled is not
 *  allowed to be a guess.
 *
 *  - `GenesisAnchorBook` answers `anchorSource()` with the compile-time constant `"genesis-testnet"`
 *    and can never answer anything else (contracts/script/GenesisAnchorBook.sol).
 *  - World ID's real Address Book has no `anchorSource()` at all — the call reverts. "Orb" is
 *    therefore claimed ONLY when the configured book is the canonical Address Book address, never
 *    merely because a call failed. A revert from some other contract is still an error.
 *
 *  Presenting a genesis anchor as Orb-verified would forge the protocol's root of trust, so this
 *  fails loudly rather than falling back to a friendly default. */
function assertKnownAnchorSource(raw: string): LiveAnchorSource {
  if (raw === "genesis-testnet") return raw;
  throw new Error(
    `GenesisAnchorBook.anchorSource() returned "${raw}", not the expected "genesis-testnet". ` +
      `Refusing to guess how to label anchors rather than risk presenting them as Orb-verified.`,
  );
}

function isWorldIdAddressBook(book: Address): boolean {
  return book.toLowerCase() === WORLD_ID_ADDRESS_BOOK.toLowerCase();
}

// ─── log fetching, chunked — public RPCs cap the block range per eth_getLogs call. 400 blocks is
// comfortably inside every provider's limit we've seen and keeps request counts low. ─────────────

// The public Alchemy RPC caps eth_getLogs at 100 blocks per call (confirmed against this exact
// endpoint — scripts/live-verify.mjs uses the same value for the same reason).
const LOG_CHUNK_BLOCKS = BigInt(100);

// How many chunk requests are in flight at once. The scan used to be strictly serial, which made
// a cold start cost (span / 100) × 4 sequential round trips — measured 2026-07-25 at ~6 100 blocks
// since deployment, that is ~244 calls at ~0.25s each, and `/api/identity/*` was answering 200 in
// 45–101s. A cold start happens on every edit under `next dev` (module cache is discarded), and
// once per process in production. 8 keeps the wall clock proportional to a single round trip
// without reproducing the ~43-requests-at-once burst that trips provider rate limits.
const LOG_CHUNK_CONCURRENCY = 8;

// The 100-block cap is Alchemy's, not the chain's. Measured directly against both configured
// providers on 2026-07-25, same address and range:
//
//     span   Alchemy                                        Tenderly
//     100    OK                                             OK
//     1000   "You can make eth_getLogs requests with up      OK
//            to a 100 block range"
//     10000  same error                                     OK
//
// Scanning the whole history at 100 blocks costs ~70 chunks × 4 event types = ~280 requests and
// measured 66s. So: ask for a wide range first, and narrow to 100 ONLY for the ranges that are
// actually refused. Against a wide-range provider the historical scan collapses to a handful of
// requests; against Alchemy it degrades to exactly the old behaviour. Neither provider is assumed
// — the code discovers which it is talking to from the error it gets back.
const LOG_CHUNK_BLOCKS_WIDE = BigInt(10_000);

/** True for a provider complaining that the requested block range is too large — as opposed to a
 *  genuine RPC failure, which must propagate rather than trigger a pointless re-scan. */
function isBlockRangeError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("block range") ||
    msg.includes("block_range") ||
    msg.includes("range is too large") ||
    msg.includes("query returned more than") ||
    msg.includes("logs matched") ||
    msg.includes("exceed maximum block range") ||
    // Every provider phrases this differently, and a phrase this list does not know about is not a
    // cosmetic miss — the request fails hard instead of narrowing, and the whole app returns 503
    // `chain_unavailable` while the chain is perfectly healthy. Observed verbatim in production:
    //   thirdweb: "Log response size exceeded. Maximum allowed number of requested blocks is 1000"
    //             (plus a bare "Request exceeds defined limit.")
    //   Alchemy:  "You can make eth_getLogs requests with up to a 100 block range"
    msg.includes("requested blocks") ||
    msg.includes("log response size") ||
    msg.includes("exceeds defined limit") ||
    msg.includes("response size exceeded") ||
    msg.includes("too many results") ||
    msg.includes("limit exceeded")
  );
}

async function getLogsChunked<const TEvent extends AbiEvent>(
  client: PublicClient,
  address: Address,
  event: TEvent,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  // Materialise the ranges first so they can be fetched with bounded concurrency and then
  // re-assembled in block order — `getLogs` results must stay ordered, since downstream code
  // treats vouch/revoke sequence as meaningful.
  const ranges: Array<{ from: bigint; to: bigint }> = [];
  for (let from = fromBlock; from <= toBlock; ) {
    const chunkEnd = from + LOG_CHUNK_BLOCKS_WIDE - BigInt(1);
    const to = chunkEnd > toBlock ? toBlock : chunkEnd;
    ranges.push({ from, to });
    from = to + BigInt(1);
  }

  /** One wide range, narrowed to `LOG_CHUNK_BLOCKS` sub-chunks only if the provider refuses it. */
  async function fetchRange(from: bigint, to: bigint): Promise<Log[]> {
    try {
      return await client.getLogs({ address, event, fromBlock: from, toBlock: to });
    } catch (err) {
      if (!isBlockRangeError(err) || to - from < LOG_CHUNK_BLOCKS) throw err;
      const narrow: Log[] = [];
      for (let f = from; f <= to; ) {
        const end = f + LOG_CHUNK_BLOCKS - BigInt(1);
        const t = end > to ? to : end;
        narrow.push(...(await client.getLogs({ address, event, fromBlock: f, toBlock: t })));
        f = t + BigInt(1);
      }
      return narrow;
    }
  }

  const results: Log[][] = new Array(ranges.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= ranges.length) return;
      const r = ranges[i];
      results[i] = await fetchRange(r.from, r.to);
    }
  }
  const workers = Math.min(LOG_CHUNK_CONCURRENCY, ranges.length);
  await Promise.all(Array.from({ length: workers }, () => worker()));

  return results.flat();
}

// ─── incremental log accumulation ─────────────────────────────────────────────────────────────
// World Chain Sepolia produces a new block roughly every second or two, which would make a naive
// "rescan every event from the deployment block on every cache miss" approach re-fetch a growing,
// unbounded history on almost every request — exactly the "public RPCs rate-limit and lag"
// problem the task calls out. Instead, remember how far we've scanned and only ever fetch the
// (usually tiny, often empty) range since last time, appending to a monotonically growing log
// set. This is still a from-scratch rescan on the very first request after a cold start, and
// still recomputes `compute()` on every call (cheap — see `getLiveGraph`'s own block-keyed
// cache), but the expensive part (getLogs against a public RPC) is paid for once per new block
// range, not once per request.

interface LogAccumulator {
  scannedThrough: bigint; // inclusive — every log up to and including this block is present
  enrolledLogs: Log[];
  vouchedLogs: Log[];
  reaffirmedLogs: Log[];
  revokedLogs: Log[];
}

let logAccumulator: LogAccumulator | null = null;
let accumulatorInFlight: Promise<void> | null = null;

async function ensureLogsThrough(
  client: PublicClient,
  avalRegistry: Address,
  deploymentBlock: bigint,
  upToBlock: bigint,
): Promise<LogAccumulator> {
  if (!logAccumulator) {
    logAccumulator = { scannedThrough: deploymentBlock - BigInt(1), enrolledLogs: [], vouchedLogs: [], reaffirmedLogs: [], revokedLogs: [] };
  }
  if (upToBlock <= logAccumulator.scannedThrough) return logAccumulator;

  if (!accumulatorInFlight) {
    const acc = logAccumulator;
    const from = acc.scannedThrough + BigInt(1);
    const to = upToBlock;
    accumulatorInFlight = (async () => {
      const [newEnrolled, newVouched, newReaffirmed, newRevoked] = await Promise.all([
        getLogsChunked(client, avalRegistry, ENROLLED_EVENT, from, to),
        getLogsChunked(client, avalRegistry, VOUCHED_EVENT, from, to),
        getLogsChunked(client, avalRegistry, REAFFIRMED_EVENT, from, to),
        getLogsChunked(client, avalRegistry, REVOKED_EVENT, from, to),
      ]);
      acc.enrolledLogs.push(...newEnrolled);
      acc.vouchedLogs.push(...newVouched);
      acc.reaffirmedLogs.push(...newReaffirmed);
      acc.revokedLogs.push(...newRevoked);
      acc.scannedThrough = to;
    })().finally(() => {
      accumulatorInFlight = null;
    });
  }
  await accumulatorInFlight;
  // Another caller may have asked for a still-newer block while we were fetching; catch up.
  return ensureLogsThrough(client, avalRegistry, deploymentBlock, upToBlock);
}

// ─── the resolved live graph ──────────────────────────────────────────────────────────────────

export interface VouchEdgeMeta {
  issuedAt: number;
  expiresAt: number;
  revoked: boolean;
}

export interface MemberInfo {
  enrolledAt: number;
  credentialExpiresAt: number;
  activeOutbound: number;
  enrolled: boolean;
  fraudulent: boolean;
}

export interface PresenceInfo {
  lastClaimAt: number;
  epochsClaimed: number;
  accrualPausedUntil: number;
}

export interface LiveGraph {
  block: bigint;
  now: number; // unix seconds — the latest block's own timestamp
  engineInput: EngineInput;
  engineOutput: EngineOutput;
  /** address -> the `handle` string it enrolled with (e.g. "carol.aval.eth"). The best display
   *  name available without a wired ENS resolver — real chain data, not a guess. */
  ensNameFor: Map<Address, string>;
  /** address -> the nullifier hash it enrolled with. Derived from the same cached `Enrolled` log
   *  scan `ensNameFor` uses (no extra RPC calls) — `usedNullifier[hash]` and this event are set
   *  atomically in `enroll()` and neither is ever unset, so the log is an equally authoritative,
   *  already-fetched source for "is this nullifier used" / "which account used it" without a
   *  dedicated per-check contract read. */
  nullifierForAccount: Map<Address, bigint>;
  /** nullifier hash (decimal string — see docs/03-worldid.md §2.3, never a JS `Number`) -> the
   *  account that used it. The `/api/enroll` uniqueness check reads this. */
  accountForNullifier: Map<string, Address>;
  /** keyed "voucher::vouchee" (both lowercased for a stable key) -> the resolved edge state, for
   *  real issuedAt/expiresAt display (docs/01-trust-math.md §14) rather than synthetic dates. */
  vouchMeta: Map<string, VouchEdgeMeta>;
  members: Map<Address, MemberInfo>;
  presence: Map<Address, PresenceInfo>;
  anchorSource: LiveAnchorSource;
}

function pairKey(voucher: Address, vouchee: Address): string {
  return `${voucher.toLowerCase()}::${vouchee.toLowerCase()}`;
}

async function fetchLiveGraph(atBlock: bigint): Promise<LiveGraph> {
  const client = getClient();
  const cfg = getConfig();

  const block = await client.getBlock({ blockNumber: atBlock });
  const now = Number(block.timestamp);

  const { enrolledLogs, vouchedLogs, reaffirmedLogs, revokedLogs } = await ensureLogsThrough(
    client,
    cfg.avalRegistry,
    cfg.deploymentBlock,
    atBlock,
  );

  // ── accounts: every distinct address that ever enrolled, plus its self-reported handle and the
  // nullifier it enrolled with (docs/03-worldid.md §2.3 uniqueness bookkeeping — see the
  // `nullifierForAccount`/`accountForNullifier` doc comments on `LiveGraph` above). ───────────────
  interface EnrolledArgs {
    account: Address;
    nullifierHash: bigint;
    handle: string;
  }
  const ensNameFor = new Map<Address, string>();
  const nullifierForAccount = new Map<Address, bigint>();
  const accountForNullifier = new Map<string, Address>();
  for (const log of enrolledLogs as unknown as Array<{ args: EnrolledArgs }>) {
    ensNameFor.set(log.args.account, log.args.handle);
    nullifierForAccount.set(log.args.account, log.args.nullifierHash);
    accountForNullifier.set(log.args.nullifierHash.toString(), log.args.account);
  }
  const addresses = [...ensNameFor.keys()];

  // ── anchor status: read LIVE from GenesisAnchorBook, never inferred from an event and never
  // cached into the scoring path (docs/03-worldid.md §3). ────────────────────────────────────────
  // These per-address reads are aggregated into Multicall3 by the client's batch config, so this
  // is one or two HTTP requests rather than one per address. They stay live and land at a single
  // block, which is what §3 actually requires — the requirement is freshness, not one request
  // each.
  // An expiry, compared against the chain's own clock — not a stored flag. Someone whose Orb
  // verification has lapsed stops being an anchor at that instant, which a boolean could not
  // express (errata E-18).
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
  const anchorExpiries = await Promise.all(
    addresses.map((addr) =>
      client.readContract({
        address: cfg.genesisAnchorBook,
        abi: GENESIS_ANCHOR_BOOK_ABI,
        functionName: "addressVerifiedUntil",
        args: [addr],
      }),
    ),
  );
  const anchorFlags = anchorExpiries.map((until) => until > nowSeconds);
  const anchorSource = await getAnchorSource(client, cfg.genesisAnchorBook);
  const isAnchorFor = new Map<Address, boolean>(addresses.map((addr, i) => [addr, anchorFlags[i]!]));

  // ── AvalRegistry.members: activeOutbound (slots), credential window, enrolled/fraudulent ──────
  const memberTuples = await Promise.all(
    addresses.map((addr) =>
      client.readContract({ address: cfg.avalRegistry, abi: AVAL_REGISTRY_ABI, functionName: "members", args: [addr] }),
    ),
  );
  const members = new Map<Address, MemberInfo>(
    addresses.map((addr, i) => {
      const [enrolledAt, credentialExpiresAt, activeOutbound, , , , enrolled, fraudulent] = memberTuples[i]!;
      return [
        addr,
        {
          enrolledAt: Number(enrolledAt),
          credentialExpiresAt: Number(credentialExpiresAt),
          activeOutbound: Number(activeOutbound),
          enrolled,
          fraudulent,
        },
      ];
    }),
  );

  // ── PresenceDrip: epochsClaimed / lastClaimAt, read live, never assumed zero ───────────────────
  const presenceTuples = await Promise.all(
    addresses.map((addr) =>
      client.readContract({ address: cfg.presenceDrip, abi: PRESENCE_DRIP_ABI, functionName: "presence", args: [addr] }),
    ),
  );
  const presence = new Map<Address, PresenceInfo>(
    addresses.map((addr, i) => {
      const [lastClaimAt, epochsClaimed, accrualPausedUntil] = presenceTuples[i]!;
      return [addr, { lastClaimAt: Number(lastClaimAt), epochsClaimed: Number(epochsClaimed), accrualPausedUntil: Number(accrualPausedUntil) }];
    }),
  );

  // ── edges: docs/01-trust-math.md §18 — "the edge set is a set." An indexer (and here, a direct
  // log scan is exactly that: an indexer of one) can legitimately emit more than one record for
  // the same (voucher, vouchee) pair — a re-affirmation, a revoke-then-vouch cycle, a reorg
  // replaying a log. We do NOT trust AvalRegistry's own `VouchExists` uniqueness check to protect
  // us here, because that check only constrains what the CURRENT contract accepts, not what
  // history the log stream can contain. Instead: replay every Vouched/Reaffirmed/Revoked event in
  // chronological (blockNumber, logIndex) order into a Map keyed by the pair, so there is
  // structurally exactly one resolved record per pair before anything downstream reads it — the
  // dedup the spec requires, and the tie-break ("prefer active over inactive, then latest
  // issuedAt") falls out for free because later events always overwrite earlier ones for the same
  // key: a fresh Vouched resets `revoked: false` with a new issuedAt/expiresAt (handling
  // revoke-then-vouch correctly), a Reaffirmed only moves expiresAt forward, and a Revoked only
  // sets the flag. ────────────────────────────────────────────────────────────────────────────
  interface VouchArgs {
    voucher: Address;
    vouchee: Address;
    issuedAt?: bigint;
    expiresAt?: bigint;
    at?: bigint;
  }
  type ReplayEvent = { kind: "Vouched" | "Reaffirmed" | "Revoked"; blockNumber: bigint; logIndex: number; args: VouchArgs };

  const toReplay = (logs: Log[], kind: ReplayEvent["kind"]): ReplayEvent[] =>
    (logs as unknown as Array<{ blockNumber: bigint; logIndex: number; args: VouchArgs }>).map((l) => ({
      kind,
      blockNumber: l.blockNumber,
      logIndex: l.logIndex,
      args: l.args,
    }));

  const replay = [
    ...toReplay(vouchedLogs, "Vouched"),
    ...toReplay(reaffirmedLogs, "Reaffirmed"),
    ...toReplay(revokedLogs, "Revoked"),
  ].sort((a, b) => (a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.logIndex - b.logIndex));

  const vouchMeta = new Map<string, VouchEdgeMeta>();
  for (const ev of replay) {
    const key = pairKey(ev.args.voucher, ev.args.vouchee);
    if (ev.kind === "Vouched") {
      vouchMeta.set(key, { issuedAt: Number(ev.args.issuedAt), expiresAt: Number(ev.args.expiresAt), revoked: false });
    } else if (ev.kind === "Reaffirmed") {
      const cur = vouchMeta.get(key);
      if (cur) cur.expiresAt = Number(ev.args.expiresAt);
    } else if (ev.kind === "Revoked") {
      const cur = vouchMeta.get(key);
      if (cur) cur.revoked = true;
    }
  }

  // ── active is a query-time predicate, not indexed state: not revoked AND not expired
  // (docs/01-trust-math.md §14, §18; docs/05-graph-data-layer.md §2.3). Evaluated against the
  // same block timestamp used as `now` everywhere else in this computation. ─────────────────────
  const addrByLower = new Map<string, Address>(addresses.map((a) => [a.toLowerCase(), a]));
  const vouches: Vouch[] = [...vouchMeta.entries()].map(([key, meta]) => {
    const [voucherLower, voucheeLower] = key.split("::") as [string, string];
    const voucher = addrByLower.get(voucherLower) ?? voucherLower;
    const vouchee = addrByLower.get(voucheeLower) ?? voucheeLower;
    const active = !meta.revoked && now < meta.expiresAt;
    return { voucher, vouchee, active };
  });

  const accounts: Account[] = addresses.map((addr) => ({
    id: addr,
    kind: "human",
    isAnchor: isAnchorFor.get(addr) ?? false,
    epochsClaimed: presence.get(addr)?.epochsClaimed ?? 0,
    active: true,
  }));

  const engineInput: EngineInput = { now, accounts, vouches, platformVouches: [], reports: [] };
  const engineOutput = compute(engineInput);

  return {
    block: atBlock,
    now,
    engineInput,
    engineOutput,
    ensNameFor,
    nullifierForAccount,
    accountForNullifier,
    vouchMeta,
    members,
    presence,
    anchorSource,
  };
}

// ─── caching, by block number (public RPCs rate-limit and lag) ───────────────────────────────────
// Two layers: the block number itself is cached briefly so a burst of requests within the same
// few seconds doesn't each pay for an `eth_blockNumber` round trip; the full graph computation
// (getLogs x4, paginated, plus ~3 reads per account) is cached per resolved block number, so two
// requests landing on the same block always return the identical, already-computed result.

const LATEST_BLOCK_TTL_MS = 4_000;
let latestBlockCache: { fetchedAt: number; block: bigint } | null = null;

async function getLatestBlockCached(): Promise<bigint> {
  const nowMs = Date.now();
  if (latestBlockCache && nowMs - latestBlockCache.fetchedAt < LATEST_BLOCK_TTL_MS) {
    return latestBlockCache.block;
  }
  const block = await getClient().getBlockNumber();
  latestBlockCache = { fetchedAt: nowMs, block };
  return block;
}

// docs/07-app-api.md §5: "cache.ts — 5s TTL, keyed by indexed block." World Chain Sepolia mints a
// new block roughly every 1-2s, so caching strictly "by block number" (recompute whenever the
// chain has moved at all) would recompute on nearly every request — the exact "public RPCs
// rate-limit and lag" failure mode the task warns about. A 5s TTL is the doc's own answer: two
// requests within the same 5s window always see the identical, already-computed result (still
// genuinely keyed by which block it was computed at — `meta.computedAtBlock` reports the real
// value, never a stale placeholder), and a burst of traffic pays the RPC cost once per window
// instead of once per request. The incremental log accumulator above means even a cache refresh
// is cheap: it only ever re-scans the (usually empty) range since the last refresh.
// 15s, not 5s. World Chain Sepolia produces a block every second or two, and a single page load
// fans out to several API routes — a 5s window meant most requests missed the cache and went
// back to the RPC. 15s is still well inside "live" for a trust score that changes on human
// timescales, and it is the difference between one upstream fetch per page and several.
const GRAPH_CACHE_TTL_MS = 15_000;
let graphCache: { fetchedAt: number; promise: Promise<LiveGraph> } | null = null;

/** The live graph, cached with a 5s TTL. */
export async function getLiveGraph(): Promise<LiveGraph> {
  const nowMs = Date.now();
  if (graphCache && nowMs - graphCache.fetchedAt < GRAPH_CACHE_TTL_MS) return graphCache.promise;
  const latest = await getLatestBlockCached();
  const promise = fetchLiveGraph(latest);
  graphCache = { fetchedAt: nowMs, promise };
  // Don't let a failed fetch poison the cache for subsequent calls.
  promise.catch(() => {
    if (graphCache?.promise === promise) graphCache = null;
  });
  return promise;
}

export interface ChainHealth {
  chainId: number;
  currentBlock: bigint;
  deploymentBlock: bigint;
}

/** Cheap, no getLogs — just the RPC's current block vs. the deployment block (requirement #3). */
export async function getChainHealth(): Promise<ChainHealth> {
  const cfg = getConfig();
  const currentBlock = await getLatestBlockCached();
  return { chainId: WORLDCHAIN_ID, currentBlock, deploymentBlock: cfg.deploymentBlock };
}

// ─── enrollment lookups for /api/enroll and /api/vouch/attest — all derived from the same cached,
// incrementally-scanned `Enrolled` log set `getLiveGraph()` already maintains. No dedicated
// per-check contract read, so none of these add to the RPC fan-out. ────────────────────────────

/** True if `nullifierHash` has already been used by ANY enrolled account — the uniqueness check
 *  the World ID nullifier exists to make possible (docs/03-worldid.md §2). Checked before signing
 *  any EnrollAttestation; the on-chain `usedNullifier` mapping this mirrors is the final backstop
 *  if two requests race inside the graph's cache TTL. */
export async function isNullifierUsed(nullifierHash: bigint): Promise<boolean> {
  const graph = await getLiveGraph();
  return graph.accountForNullifier.has(nullifierHash.toString());
}

/** The account already enrolled with `nullifierHash`, if any — lets `/api/enroll` name the
 *  situation ("this World ID is already registered") without a second on-chain read. */
export async function findAccountByNullifier(nullifierHash: bigint): Promise<Address | null> {
  const graph = await getLiveGraph();
  return graph.accountForNullifier.get(nullifierHash.toString()) ?? null;
}

export async function isAddressEnrolled(address: Address): Promise<boolean> {
  const graph = await getLiveGraph();
  return graph.members.get(address)?.enrolled ?? false;
}

/** The canonical handle `address` enrolled with on `AvalRegistry` (e.g. "carol.aval.eth") — the
 *  same value `ensNameFor` renders everywhere else, exposed as a single-address lookup for
 *  `/api/ens/mint` (docs/04-ens.md §6: "chosen at enrollment; immutable thereafter", so this is
 *  also the only handle that route will ever mint for a given address). */
export async function getEnrollmentHandle(address: Address): Promise<string | null> {
  const graph = await getLiveGraph();
  return graph.ensNameFor.get(address) ?? null;
}

/** The nullifier hash `address` originally enrolled with. `/api/vouch/attest` compares this
 *  against the presence proof's nullifier (docs/03-worldid.md §5.1: same action ⇒ same nullifier
 *  ⇒ "compare directly to the stored enrollment nullifier" — stored here as the `Enrolled` event
 *  itself, since this build keeps no separate database). */
export async function getEnrollmentNullifier(address: Address): Promise<bigint | null> {
  const graph = await getLiveGraph();
  return graph.nullifierForAccount.get(address) ?? null;
}

/** Live-computed tier for `address`, straight from the same engine `compute()` every other number
 *  in this app comes from — what `/api/vouch/attest` attests as `voucherTier` and what
 *  `/api/presence/attest` attests as `tier` for `PresenceDrip.claim`. */
export async function getLiveTier(address: Address): Promise<0 | 1 | 2> {
  const graph = await getLiveGraph();
  return (graph.engineOutput.tier[address] ?? 0) as 0 | 1 | 2;
}

const PRESENCE_ACCRUED_ABI = [
  {
    type: "function",
    name: "accrued",
    stateMutability: "view",
    inputs: [{ name: "a", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** `PresenceDrip.accrued(address)` — the real, tier-blind nominal amount owed, read live for
 *  whichever single address is currently being viewed (never batched across every account: this
 *  is one call per page load of a signed-in user, not the N-account fan-out the Multicall3 batch
 *  config exists to avoid). Returned in wei (1e18 = 1 AVAL) so the caller controls rounding. */
export async function getAccruedDrip(address: Address): Promise<bigint> {
  const cfg = getConfig();
  return getClient().readContract({
    address: cfg.presenceDrip,
    abi: PRESENCE_ACCRUED_ABI,
    functionName: "accrued",
    args: [address],
  });
}
