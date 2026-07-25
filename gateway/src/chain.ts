// @aval/gateway — src/chain.ts
//
// Live World Chain Sepolia reads — the trust graph's actual data source. There is no deployed
// Aval Subgraph (deployments/worldchain-sepolia.json's own notes), so every number this module
// produces is read directly off `AvalRegistry` events / view functions and
// `GenesisAnchorBook.getIsUserVerified` — no indexer, no cache-as-source-of-truth, no fabricated
// deployment id (the gateway's `aval.subgraph` text record — see context.ts — is the literal
// string `direct-chain-read:4801`, never a guessed IPFS hash).
//
// Mirrors app/src/lib/chain.ts's approach closely (same event ABI fragments, same Multicall3
// batching, same chunked getLogs, same chronological Vouched/Reaffirmed/Revoked replay per
// (voucher, vouchee) pair — docs/01-trust-math.md §18: a log replay can legitimately emit more
// than one record for the same pair, and summing duplicates is a Sybil hole, not a tidiness
// concern). Kept self-contained rather than imported from app/, because this package must not
// depend on app/.
//
// Contract addresses and the deployment block are READ from deployments/worldchain-sepolia.json
// at runtime — the authoritative record — never retyped as literals here.

import { readFileSync } from "node:fs";
import {
  createPublicClient,
  fallback,
  http,
  keccak256,
  toBytes,
  type AbiEvent,
  type Address,
  type Chain,
  type Log,
  type PublicClient,
  type Transport,
} from "viem";

// ── deployment record ────────────────────────────────────────────────────────────────────────

// gateway/dist/chain.js (built) and gateway/src/chain.ts (dev, via tsx) are both exactly two
// directories under the repo root, so this relative walk resolves the same way in both cases.
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

interface DeploymentRecord {
  chainId: number;
  deploymentBlock: number;
  contracts: {
    AvalRegistry: { address: Address };
    GenesisAnchorBook: { address: Address };
  };
}

let cachedDeployment: DeploymentRecord | null = null;
function loadDeployment(): DeploymentRecord {
  if (cachedDeployment) return cachedDeployment;
  const raw = readFileSync(`${REPO_ROOT}deployments/worldchain-sepolia.json`, "utf8");
  cachedDeployment = JSON.parse(raw) as DeploymentRecord;
  return cachedDeployment;
}

export function getAvalRegistryAddress(): Address {
  return loadDeployment().contracts.AvalRegistry.address;
}
export function getAnchorBookAddress(): Address {
  return loadDeployment().contracts.GenesisAnchorBook.address;
}
export function getDeploymentBlock(): bigint {
  return BigInt(loadDeployment().deploymentBlock);
}

/** What every `aval.subgraph` text record reports: there is no subgraph, and this provenance
 *  string says so rather than naming a fabricated deployment ID. */
export const CHAIN_PROVENANCE = "direct-chain-read:4801";

// ── chain + transport ────────────────────────────────────────────────────────────────────────

const WORLDCHAIN_SEPOLIA_ID = 4801;
const DEFAULT_PRIMARY_RPC = "https://worldchain-sepolia.gateway.tenderly.co";
// Alchemy's public endpoint rate-limits hard — fallback only, never primary.
const DEFAULT_FALLBACK_RPC = "https://worldchain-sepolia.g.alchemy.com/public";

// Canonical Multicall3 address; deployed on World Chain Sepolia.
const MULTICALL3_ADDRESS: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

function worldChainSepolia(): Chain {
  return {
    id: WORLDCHAIN_SEPOLIA_ID,
    name: "World Chain Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [DEFAULT_PRIMARY_RPC] } },
    // Required for the client's multicall batching to have somewhere to aggregate into — without
    // this entry viem silently falls back to one HTTP request per read (see getClient() below).
    contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
  };
}

/** Tenderly primary, Alchemy public fallback ONLY — Alchemy's public endpoint rate-limits hard.
 *  `WORLDCHAIN_SEPOLIA_RPC` overrides the primary for local testing;
 *  `WORLDCHAIN_SEPOLIA_RPC_FALLBACK` overrides the fallback. */
function buildTransport(env: NodeJS.ProcessEnv): Transport {
  const primary = env.WORLDCHAIN_SEPOLIA_RPC ?? DEFAULT_PRIMARY_RPC;
  const secondary = env.WORLDCHAIN_SEPOLIA_RPC_FALLBACK ?? DEFAULT_FALLBACK_RPC;
  const urls = [...new Set([primary, secondary])];
  const transports = urls.map((u) => http(u, { retryCount: 4, retryDelay: 600, batch: true }));
  return transports.length === 1 ? transports[0]! : fallback(transports);
}

let cachedClient: PublicClient | null = null;
function getClient(): PublicClient {
  if (cachedClient) return cachedClient;
  cachedClient = createPublicClient({
    chain: worldChainSepolia(),
    transport: buildTransport(process.env),
    // Aggregate concurrent eth_calls (getIsUserVerified / members, once per account) into
    // Multicall3 instead of firing one HTTP request per account — a naive per-account fan-out
    // trips the public RPC's rate limit immediately.
    batch: { multicall: { batchSize: 1024, wait: 16 } },
  });
  return cachedClient;
}

// ── ABI fragments — exactly the surface read, matching contracts/src/AvalRegistry.sol and
// contracts/src/GenesisAnchorBook.sol, and identical to app/src/lib/chain.ts's own fragments. ───

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

/** GenesisAnchorBook is honest by contract design: `anchorSource()` returns "genesis-testnet",
 *  never "world-id-orb". Refuses to guess a label if it's ever anything else — presenting a
 *  genesis anchor as an Orb anchor would forge the one externally-grounded fact in the protocol. */
export type LiveAnchorSource = "genesis-testnet";

let cachedAnchorSource: LiveAnchorSource | null = null;
async function getAnchorSource(client: PublicClient, book: Address): Promise<LiveAnchorSource> {
  if (cachedAnchorSource) return cachedAnchorSource;
  const raw = await client.readContract({ address: book, abi: GENESIS_ANCHOR_BOOK_ABI, functionName: "anchorSource" });
  if (raw !== "genesis-testnet") {
    throw new Error(
      `GenesisAnchorBook.anchorSource() returned "${raw}", not the expected "genesis-testnet". ` +
        `Refusing to guess how to label anchors rather than risk presenting them as Orb-verified.`,
    );
  }
  cachedAnchorSource = raw;
  return cachedAnchorSource;
}

// ── credential labels — bytes32 = keccak256(bytes(name)); an unrecognized hash is surfaced
// verbatim rather than guessed (docs/03-worldid.md: "orb" | "selfie-check" | "document"). ────────

const CRED_ORB = keccak256(toBytes("orb"));
const CRED_SELFIE = keccak256(toBytes("selfie-check"));
const CRED_DOCUMENT = keccak256(toBytes("document"));

function credentialLabel(hash: string): string {
  if (hash === CRED_ORB) return "orb";
  if (hash === CRED_SELFIE) return "selfie-check";
  if (hash === CRED_DOCUMENT) return "document";
  return hash;
}

// ── log fetching, chunked — the public RPC gateway caps eth_getLogs at 100 blocks per call
// (app/src/lib/chain.ts uses the same value for the same reason). ──────────────────────────────

const LOG_CHUNK_BLOCKS = 100n;

async function getLogsChunked(
  client: PublicClient,
  address: Address,
  event: AbiEvent,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Log[]> {
  const logs: Log[] = [];
  let from = fromBlock;
  while (from <= toBlock) {
    const chunkEnd = from + LOG_CHUNK_BLOCKS - 1n;
    const to = chunkEnd > toBlock ? toBlock : chunkEnd;
    const chunk = await client.getLogs({ address, event, fromBlock: from, toBlock: to });
    logs.push(...chunk);
    from = to + 1n;
  }
  return logs;
}

// Incremental, monotonically-growing accumulator, module-level so repeat resolutions within one
// gateway process don't rescan from the deployment block every time.
interface LogAccumulator {
  scannedThrough: bigint; // inclusive
  enrolled: Log[];
  vouched: Log[];
  reaffirmed: Log[];
  revoked: Log[];
}
let accumulator: LogAccumulator | null = null;
let accumulatorInFlight: Promise<void> | null = null;

async function ensureLogsThrough(
  client: PublicClient,
  registry: Address,
  deployBlock: bigint,
  upToBlock: bigint,
): Promise<LogAccumulator> {
  if (!accumulator) {
    accumulator = { scannedThrough: deployBlock - 1n, enrolled: [], vouched: [], reaffirmed: [], revoked: [] };
  }
  if (upToBlock <= accumulator.scannedThrough) return accumulator;

  if (!accumulatorInFlight) {
    const acc = accumulator;
    const from = acc.scannedThrough + 1n;
    accumulatorInFlight = (async () => {
      const [e, v, r, k] = await Promise.all([
        getLogsChunked(client, registry, ENROLLED_EVENT, from, upToBlock),
        getLogsChunked(client, registry, VOUCHED_EVENT, from, upToBlock),
        getLogsChunked(client, registry, REAFFIRMED_EVENT, from, upToBlock),
        getLogsChunked(client, registry, REVOKED_EVENT, from, upToBlock),
      ]);
      acc.enrolled.push(...e);
      acc.vouched.push(...v);
      acc.reaffirmed.push(...r);
      acc.revoked.push(...k);
      acc.scannedThrough = upToBlock;
    })().finally(() => {
      accumulatorInFlight = null;
    });
  }
  await accumulatorInFlight;
  return ensureLogsThrough(client, registry, deployBlock, upToBlock);
}

// ── the graph shapes context.ts consumes — the same field names subgraph.ts re-exports. ────────

export type AccountStatus = "ACTIVE" | "GRACE" | "SUSPENDED" | "FRAUDULENT";

export interface InboundEdge {
  voucherId: string;
  expiresAt: bigint;
}

export interface SubgraphAccount {
  id: string;
  isAnchor: boolean;
  status: AccountStatus;
  credentialExpiresAt: bigint;
  inbound: InboundEdge[]; // already filtered: revoked=false, expiresAt > now
}

export interface TrustGraphSnapshot {
  accounts: SubgraphAccount[];
  blockNumber: bigint;
  deploymentId: string;
  fetchedAt: number;
}

export interface NamingAccount {
  id: string;
  handle: string;
  isAnchor: boolean;
  credential: string;
}

export interface NamingEdge {
  voucherId: string;
  voucheeId: string;
  issuedAt: bigint;
  expiresAt: bigint;
}

export interface NamingSnapshot {
  accounts: NamingAccount[];
  edges: NamingEdge[];
  blockNumber: bigint;
  deploymentId: string;
}

function pairKey(voucher: Address, vouchee: Address): string {
  return `${voucher.toLowerCase()}::${vouchee.toLowerCase()}`;
}

function deriveStatus(now: number, credentialExpiresAt: number, fraudulent: boolean, graceDays: number): AccountStatus {
  if (fraudulent) return "FRAUDULENT";
  if (now < credentialExpiresAt) return "ACTIVE";
  if (now < credentialExpiresAt + graceDays * 24 * 60 * 60) return "GRACE";
  return "SUSPENDED";
}

// Credential grace window (docs/10-constants.md §14: CREDENTIAL_GRACE_DAYS = 14). Kept local
// rather than imported from @aval/engine so this low-level chain reader stays independent of the
// engine, which context.ts (not this file) is the one to call.
const CREDENTIAL_GRACE_DAYS = 14;

interface EnrolledArgs {
  account: Address;
  credential: `0x${string}`;
  credentialExpiresAt: bigint;
  handle: string;
}
interface VouchArgs {
  voucher: Address;
  vouchee: Address;
  issuedAt?: bigint;
  expiresAt?: bigint;
  at?: bigint;
}
type ReplayEvent = {
  kind: "Vouched" | "Reaffirmed" | "Revoked";
  blockNumber: bigint;
  logIndex: number;
  args: VouchArgs;
};

interface LiveGraph {
  now: number;
  accounts: {
    id: Address;
    handle: string;
    isAnchor: boolean;
    status: AccountStatus;
    credential: string;
    credentialExpiresAt: bigint;
  }[];
  vouches: { voucherId: Address; voucheeId: Address; issuedAt: bigint; expiresAt: bigint }[]; // already active-filtered
}

async function fetchLiveGraphAtBlock(atBlock: bigint): Promise<LiveGraph> {
  const client = getClient();
  const registry = getAvalRegistryAddress();
  const anchorBook = getAnchorBookAddress();
  const deployBlock = getDeploymentBlock();

  const block = await client.getBlock({ blockNumber: atBlock });
  const now = Number(block.timestamp);

  const acc = await ensureLogsThrough(client, registry, deployBlock, atBlock);
  const upTo = <T extends { blockNumber: bigint | null }>(logs: T[]): T[] =>
    logs.filter((l) => (l.blockNumber ?? 0n) <= atBlock);
  const enrolledLogs = upTo(acc.enrolled);
  const vouchedLogs = upTo(acc.vouched);
  const reaffirmedLogs = upTo(acc.reaffirmed);
  const revokedLogs = upTo(acc.revoked);

  const handleFor = new Map<Address, string>();
  const credentialFor = new Map<Address, string>();
  for (const log of enrolledLogs as unknown as Array<{ args: EnrolledArgs }>) {
    handleFor.set(log.args.account, log.args.handle);
    credentialFor.set(log.args.account, credentialLabel(log.args.credential));
  }
  const addresses = [...handleFor.keys()];

  const anchorFlags = await Promise.all(
    addresses.map((addr) =>
      client.readContract({
        address: anchorBook,
        abi: GENESIS_ANCHOR_BOOK_ABI,
        functionName: "getIsUserVerified",
        args: [addr],
        blockNumber: atBlock,
      }),
    ),
  );
  const isAnchorFor = new Map<Address, boolean>(addresses.map((a, i) => [a, anchorFlags[i]!]));

  const memberTuples = await Promise.all(
    addresses.map((addr) =>
      client.readContract({
        address: registry,
        abi: AVAL_REGISTRY_ABI,
        functionName: "members",
        args: [addr],
        blockNumber: atBlock,
      }),
    ),
  );

  const accounts: LiveGraph["accounts"] = [];
  addresses.forEach((addr, i) => {
    const [, credentialExpiresAt, , , , , enrolled, fraudulent] = memberTuples[i]!;
    if (!enrolled) return;
    const status = deriveStatus(now, Number(credentialExpiresAt), fraudulent, CREDENTIAL_GRACE_DAYS);
    if (status === "FRAUDULENT") return; // excluded from the graph entirely
    accounts.push({
      id: addr,
      handle: handleFor.get(addr) ?? "",
      isAnchor: isAnchorFor.get(addr) ?? false,
      status,
      credential: credentialFor.get(addr) ?? "",
      credentialExpiresAt,
    });
  });
  const validIds = new Set(accounts.map((a) => a.id.toLowerCase()));

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

  interface PairState {
    voucher: Address;
    vouchee: Address;
    issuedAt: bigint;
    expiresAt: bigint;
    revoked: boolean;
  }
  const pairState = new Map<string, PairState>();
  for (const ev of replay) {
    const key = pairKey(ev.args.voucher, ev.args.vouchee);
    if (ev.kind === "Vouched") {
      pairState.set(key, {
        voucher: ev.args.voucher,
        vouchee: ev.args.vouchee,
        issuedAt: ev.args.issuedAt!,
        expiresAt: ev.args.expiresAt!,
        revoked: false,
      });
    } else if (ev.kind === "Reaffirmed") {
      const cur = pairState.get(key);
      if (cur) cur.expiresAt = ev.args.expiresAt!;
    } else if (ev.kind === "Revoked") {
      const cur = pairState.get(key);
      if (cur) cur.revoked = true;
    }
  }

  const vouches: LiveGraph["vouches"] = [];
  for (const state of pairState.values()) {
    if (!validIds.has(state.voucher.toLowerCase()) || !validIds.has(state.vouchee.toLowerCase())) continue;
    const active = !state.revoked && now < Number(state.expiresAt);
    if (!active) continue;
    vouches.push({ voucherId: state.voucher, voucheeId: state.vouchee, issuedAt: state.issuedAt, expiresAt: state.expiresAt });
  }

  return { now, accounts, vouches };
}

// ── caching — by latest block, short TTL. Two flavors of the same underlying live read: the
// scoring-oriented TrustGraphSnapshot and the naming-oriented NamingSnapshot, both derived from
// one shared fetch so a single resolution only reads the chain once. ───────────────────────────

const LATEST_BLOCK_TTL_MS = 4_000;
let latestBlockCache: { fetchedAt: number; block: bigint } | null = null;

async function getLatestBlockCached(): Promise<bigint> {
  const nowMs = Date.now();
  if (latestBlockCache && nowMs - latestBlockCache.fetchedAt < LATEST_BLOCK_TTL_MS) return latestBlockCache.block;
  const block = await getClient().getBlockNumber();
  latestBlockCache = { fetchedAt: nowMs, block };
  return block;
}

interface CombinedCacheEntry {
  fetchedAt: number;
  blockNumber: bigint;
  promise: Promise<LiveGraph>;
}
let liveGraphCache: CombinedCacheEntry | null = null;

async function getLiveGraphCached(ttlMs: number): Promise<{ graph: LiveGraph; blockNumber: bigint }> {
  const nowMs = Date.now();
  if (liveGraphCache && nowMs - liveGraphCache.fetchedAt < ttlMs) {
    return { graph: await liveGraphCache.promise, blockNumber: liveGraphCache.blockNumber };
  }
  const blockNumber = await getLatestBlockCached();
  const promise = fetchLiveGraphAtBlock(blockNumber);
  liveGraphCache = { fetchedAt: nowMs, blockNumber, promise };
  promise.catch(() => {
    if (liveGraphCache?.promise === promise) liveGraphCache = null;
  });
  return { graph: await promise, blockNumber };
}

export function clearTrustGraphCache(): void {
  liveGraphCache = null;
  accumulator = null;
  latestBlockCache = null;
}

export interface GetTrustGraphOptions {
  ttlMs?: number | undefined;
  now?: bigint | undefined;
}

/** Trust graph shaped for @aval/engine's compute() input — inbound edges already active-filtered
 *  (docs/01-trust-math.md §14, §18: expiry is a query-time predicate, and duplicate/replayed
 *  (voucher, vouchee) records are resolved to exactly one edge before anything downstream sees
 *  them). `options.now` is accepted for API compatibility with subgraph.ts's signature but is not
 *  used: the active-filter always runs against the read block's own timestamp — the same "active"
 *  answer the chain itself would give at that block, not a caller-substituted one. */
export async function getTrustGraph(
  _config: ChainClientConfig,
  options: GetTrustGraphOptions = {},
): Promise<TrustGraphSnapshot> {
  const ttlMs = options.ttlMs ?? 5000;
  const { graph, blockNumber } = await getLiveGraphCached(ttlMs);

  const inboundByAccount = new Map<string, InboundEdge[]>();
  for (const v of graph.vouches) {
    const list = inboundByAccount.get(v.voucheeId.toLowerCase()) ?? [];
    list.push({ voucherId: v.voucherId.toLowerCase(), expiresAt: v.expiresAt });
    inboundByAccount.set(v.voucheeId.toLowerCase(), list);
  }

  const accounts: SubgraphAccount[] = graph.accounts.map((a) => ({
    id: a.id.toLowerCase(),
    isAnchor: a.isAnchor,
    status: a.status,
    credentialExpiresAt: a.credentialExpiresAt,
    inbound: inboundByAccount.get(a.id.toLowerCase()) ?? [],
  }));

  return { accounts, blockNumber, deploymentId: CHAIN_PROVENANCE, fetchedAt: Date.now() };
}

/** Naming graph shaped for resolve.ts's ENS-path walk — same live read as getTrustGraph, reshaped
 *  for handle/issuedAt instead of scoring fields. */
export async function getNamingGraph(
  _config: ChainClientConfig,
  options: GetTrustGraphOptions = {},
): Promise<NamingSnapshot> {
  const ttlMs = options.ttlMs ?? 5000;
  const { graph, blockNumber } = await getLiveGraphCached(ttlMs);

  const accounts: NamingAccount[] = graph.accounts.map((a) => ({
    id: a.id.toLowerCase(),
    handle: a.handle,
    isAnchor: a.isAnchor,
    credential: a.credential,
  }));
  const edges: NamingEdge[] = graph.vouches.map((v) => ({
    voucherId: v.voucherId.toLowerCase(),
    voucheeId: v.voucheeId.toLowerCase(),
    issuedAt: v.issuedAt,
    expiresAt: v.expiresAt,
  }));

  return { accounts, edges, blockNumber, deploymentId: CHAIN_PROVENANCE };
}

/** Config placeholder — exists so context.ts's `GatewayConfig.chain: ChainClientConfig` field has
 *  something concrete to name. There is nothing to configure beyond the RPC env vars
 *  `buildTransport()` already reads directly, since contract addresses come from
 *  deployments/worldchain-sepolia.json, not caller-supplied config. */
export interface ChainClientConfig {
  rpcUrl?: string | undefined;
}

/** True live anchor check — bypasses the graph cache entirely (docs/03-worldid.md §3: anchor
 *  status is never cached into the scoring path). */
export async function checkAnchorStatusLive(address: Address): Promise<{ isAnchor: boolean; anchorSource: LiveAnchorSource; contract: Address }> {
  const client = getClient();
  const anchorBook = getAnchorBookAddress();
  const [isAnchor, anchorSource] = await Promise.all([
    client.readContract({ address: anchorBook, abi: GENESIS_ANCHOR_BOOK_ABI, functionName: "getIsUserVerified", args: [address] }),
    getAnchorSource(client, anchorBook),
  ]);
  return { isAnchor, anchorSource, contract: anchorBook };
}
