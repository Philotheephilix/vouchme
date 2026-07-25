/**
 * app/src/lib/chain.ts
 *
 * The live data source: World Chain Sepolia, read directly with viem. No subgraph, no indexer —
 * this reads `Enrolled` / `Vouched` / `Reaffirmed` / `Revoked` logs from `AvalRegistry` straight
 * off the chain, resolves anchor status live from `GenesisAnchorBook.getIsUserVerified` (never
 * cached into the scoring path — docs/03-worldid.md §3), and reads presence-drip state from
 * `PresenceDrip`. It assembles the exact `EngineInput` shape `@aval/engine` expects and hands the
 * caller that input plus the real `EngineOutput` from `compute()` — this module never formats a
 * score itself. Every number still comes from the engine (docs/01-trust-math.md).
 *
 * Server-only. Never imported from a "use client" component.
 */

import {
  createPublicClient,
  getAddress,
  http,
  type AbiEvent,
  type Address,
  type Chain,
  type Log,
  type PublicClient,
} from "viem";
import { compute, type Account, type EngineInput, type EngineOutput, type Vouch } from "@aval/engine";

// ─── World Chain Sepolia ──────────────────────────────────────────────────────────────────────
// chainId 4801 is a stable public fact about the network itself (not a deployment artifact), so
// it is a named constant here rather than an env var — same convention every script in this repo
// uses (scripts/live-verify.mjs, scripts/live-scenario.mjs both hardcode `id: 4801`).
export const WORLDCHAIN_SEPOLIA_ID = 4801;

const worldChainSepolia = (rpcUrl: string): Chain => ({
  id: WORLDCHAIN_SEPOLIA_ID,
  name: "World Chain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  contracts: {
    // Required for the client's multicall batching to have somewhere to aggregate into —
    // without this entry viem silently falls back to one HTTP request per read.
    // Canonical Multicall3 address; presence verified on chain 4801 (7618 bytes), not assumed.
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
  rpcUrl: string;
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
function requireEnvAny(names: string[]): string {
  for (const name of names) {
    const v = process.env[name];
    if (v) return v;
  }
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
    rpcUrl: requireEnvAny([
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
    chain: worldChainSepolia(cfg.rpcUrl),
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
    transport: http(cfg.rpcUrl, { retryCount: 5, retryDelay: 750, batch: true }),
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
    type: "function",
    name: "getIsUserVerified",
    stateMutability: "view",
    inputs: [{ name: "user", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
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
export type LiveAnchorSource = "genesis-testnet";

function assertKnownAnchorSource(raw: string): LiveAnchorSource {
  if (raw === "genesis-testnet") return raw;
  throw new Error(
    `GenesisAnchorBook.anchorSource() returned "${raw}", not the expected "genesis-testnet". ` +
      `Refusing to guess how to label anchors rather than risk presenting them as Orb-verified.`,
  );
}

// ─── log fetching, chunked — public RPCs cap the block range per eth_getLogs call. 400 blocks is
// comfortably inside every provider's limit we've seen and keeps request counts low. ─────────────

// The public Alchemy RPC caps eth_getLogs at 100 blocks per call (confirmed against this exact
// endpoint — scripts/live-verify.mjs uses the same value for the same reason).
const LOG_CHUNK_BLOCKS = BigInt(100);

async function getLogsChunked<const TEvent extends AbiEvent>(
  client: PublicClient,
  address: Address,
  event: TEvent,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  const logs: Log[] = [];
  let from = fromBlock;
  while (from <= toBlock) {
    const chunkEnd = from + LOG_CHUNK_BLOCKS - BigInt(1);
    const to = chunkEnd > toBlock ? toBlock : chunkEnd;
    const chunk = await client.getLogs({ address, event, fromBlock: from, toBlock: to });
    logs.push(...chunk);
    from = to + BigInt(1);
  }
  return logs;
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
  const anchorFlags = await Promise.all(
    addresses.map((addr) =>
      client.readContract({
        address: cfg.genesisAnchorBook,
        abi: GENESIS_ANCHOR_BOOK_ABI,
        functionName: "getIsUserVerified",
        args: [addr],
      }),
    ),
  );
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
  return { chainId: WORLDCHAIN_SEPOLIA_ID, currentBlock, deploymentBlock: cfg.deploymentBlock };
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
