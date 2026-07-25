// @aval/mcp — src/chain.ts
//
// Live World Chain Sepolia reads — the trust graph's actual data source for this deployment.
// There is no deployed Aval Subgraph (deployments/worldchain-sepolia.json's own notes). Every
// number this module produces is read directly off `AvalRegistry` events / view functions and
// `GenesisAnchorBook.getIsUserVerified` — no indexer, no cache-as-source-of-truth, no fabricated
// deployment id (`meta.deploymentId` is the honest literal string `direct-chain-read:4801`, never
// a guessed IPFS hash). Matches docs/01-trust-math.md §12.1's worked table.
//
// Mirrors app/src/lib/chain.ts's approach closely (same event ABI fragments, same Multicall3
// batching, same chunked getLogs, same chronological Vouched/Reaffirmed/Revoked replay per
// (voucher, vouchee) pair — docs/01-trust-math.md §18: an indexer/log-replay can legitimately
// emit more than one record for the same pair, and summing duplicates is a real Sybil hole, not a
// tidiness concern). Kept self-contained here rather than imported from app/: this package must
// not depend on app/, and @aval/mcp's TrustGraph shape differs from app's LiveGraph shape.
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
import { CREDENTIAL_GRACE_DAYS } from "@aval/engine";
import type { SubgraphMeta } from "./client.js";

// ── deployment record ────────────────────────────────────────────────────────────────────────

// mcp/dist/chain.js (built) and mcp/src/chain.ts (dev, via tsx) are both exactly two directories
// under the repo root, so this relative walk resolves the same way in both cases.
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

/** What `meta.deploymentId` reports everywhere in this server — honest about there being no
 *  subgraph rather than a fabricated deployment ID. */
export const CHAIN_PROVENANCE = "direct-chain-read:4801";

// ── chain + transport ────────────────────────────────────────────────────────────────────────

const WORLDCHAIN_SEPOLIA_ID = 4801;
const DEFAULT_PRIMARY_RPC = "https://worldchain-sepolia.gateway.tenderly.co";
// Alchemy's public endpoint rate-limits hard — fallback only, never primary.
const DEFAULT_FALLBACK_RPC = "https://worldchain-sepolia.g.alchemy.com/public";

// Canonical Multicall3 address; verified deployed on World Chain Sepolia.
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

/** Test/dev-only escape hatch: drop every cached client/log/graph so the next call re-derives
 *  everything (including a possibly-changed RPC transport) from scratch. */
export function resetChainClientForTests(): void {
  cachedClient = null;
}

// ── ABI fragments — exactly the surface read, matching contracts/src/AvalRegistry.sol and
// contracts/src/GenesisAnchorBook.sol, and identical to app/src/lib/chain.ts's own fragments
// (verified against this exact live deployment). ────────────────────────────────────────────────

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

// ── account status — derived at read time from credentialExpiresAt, exactly the rule
// docs/05-graph-data-layer.md §2.3 describes for a Subgraph reader ("GRACE and SUSPENDED are
// derived at read time from credentialExpiresAt"); we are that reader now, just without a
// Subgraph in between. FRAUDULENT (members().fraudulent) overrides everything. ───────────────────

export type AccountStatus = "ACTIVE" | "GRACE" | "SUSPENDED" | "FRAUDULENT";

function deriveStatus(now: number, credentialExpiresAt: number, fraudulent: boolean): AccountStatus {
  if (fraudulent) return "FRAUDULENT";
  if (now < credentialExpiresAt) return "ACTIVE";
  const graceEnd = credentialExpiresAt + CREDENTIAL_GRACE_DAYS * 24 * 60 * 60;
  if (now < graceEnd) return "GRACE";
  return "SUSPENDED";
}

// ── log fetching, chunked — the public RPC gateway caps eth_getLogs at 100 blocks per call
// (confirmed against this exact endpoint; scripts/live-verify.mjs and app/src/lib/chain.ts use
// the same value for the same reason). ─────────────────────────────────────────────────────────

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

// Incremental, monotonically-growing accumulator, module-level so repeat tool calls within one
// server process don't rescan from the deployment block every time. Grows forward only; a request
// for a block BEHIND what's already scanned is served by filtering the existing set down (see
// fetchGraphAtBlock below) rather than re-fetching — this is what makes aval_history's time-travel
// queries cheap on repeat calls too.
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
  // Another caller may have asked for a still-newer block while we were fetching; catch up.
  return ensureLogsThrough(client, registry, deployBlock, upToBlock);
}

// ── the trust graph shape @aval/mcp's engine.ts (and every tool built on it) consumes ───────────

export interface GraphAccount {
  id: string; // lowercase address
  handle: string;
  isAnchor: boolean;
  status: AccountStatus;
  credential: string;
  credentialExpiresAt: bigint;
  activeOutboundCount: number;
}

export interface GraphVouch {
  voucherId: string;
  voucheeId: string;
  issuedAt: bigint;
  expiresAt: bigint;
}

export interface TrustGraph {
  accounts: GraphAccount[];
  /** Already active-filtered (not revoked, not expired as of `meta.blockNumber`'s own timestamp)
   *  AND already deduplicated to one resolved edge per (voucher, vouchee) pair — see the
   *  chronological replay below, docs/01-trust-math.md §18. */
  vouches: GraphVouch[];
  meta: SubgraphMeta;
}

function pairKey(voucher: Address, vouchee: Address): string {
  return `${voucher.toLowerCase()}::${vouchee.toLowerCase()}`;
}

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

async function fetchGraphAtBlock(atBlock: bigint): Promise<TrustGraph> {
  const client = getClient();
  const registry = getAvalRegistryAddress();
  const anchorBook = getAnchorBookAddress();
  const deployBlock = getDeploymentBlock();

  const block = await client.getBlock({ blockNumber: atBlock });
  const now = Number(block.timestamp);

  const acc = await ensureLogsThrough(client, registry, deployBlock, atBlock);
  // The shared accumulator may have scanned PAST atBlock (a later "latest" call already grew it) —
  // filter back down to a point-in-time view rather than re-fetching.
  const upTo = <T extends { blockNumber: bigint | null }>(logs: T[]): T[] =>
    logs.filter((l) => (l.blockNumber ?? 0n) <= atBlock);
  const enrolledLogs = upTo(acc.enrolled);
  const vouchedLogs = upTo(acc.vouched);
  const reaffirmedLogs = upTo(acc.reaffirmed);
  const revokedLogs = upTo(acc.revoked);

  // ── accounts: every distinct address that ever enrolled (by `atBlock`), plus its immutable
  // handle and enrollment credential. ───────────────────────────────────────────────────────────
  const handleFor = new Map<Address, string>();
  const credentialFor = new Map<Address, string>();
  for (const log of enrolledLogs as unknown as Array<{ args: EnrolledArgs }>) {
    handleFor.set(log.args.account, log.args.handle);
    credentialFor.set(log.args.account, credentialLabel(log.args.credential));
  }
  const addresses = [...handleFor.keys()];

  // ── anchor status: read LIVE from GenesisAnchorBook, never inferred from an event. Batched into
  // Multicall3 by the client's batch config (getClient() above) — one or two HTTP requests, not
  // one per address. ────────────────────────────────────────────────────────────────────────────
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

  // ── AvalRegistry.members: activeOutbound (slots used), fraudulent flag, live credential window.
  // Also Multicall3-batched. ────────────────────────────────────────────────────────────────────
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

  const accounts: GraphAccount[] = [];
  addresses.forEach((addr, i) => {
    const [, credentialExpiresAt, activeOutbound, , , , enrolled, fraudulent] = memberTuples[i]!;
    if (!enrolled) return; // defensive — every address with an Enrolled log should read enrolled=true
    const status = deriveStatus(now, Number(credentialExpiresAt), fraudulent);
    // Matches the original subgraph.yaml query's own `where: { status_not: FRAUDULENT }` — a
    // fraudulent account (and, downstream, any vouch it issued) is excluded from the graph
    // entirely, not merely flagged.
    if (status === "FRAUDULENT") return;
    accounts.push({
      id: addr.toLowerCase(),
      handle: handleFor.get(addr) ?? "",
      isAnchor: isAnchorFor.get(addr) ?? false,
      status,
      credential: credentialFor.get(addr) ?? "",
      credentialExpiresAt,
      activeOutboundCount: Number(activeOutbound),
    });
  });
  const validIds = new Set(accounts.map((a) => a.id));

  // ── edges: replay Vouched/Reaffirmed/Revoked chronologically per (voucher, vouchee) pair to
  // resolve final state — docs/01-trust-math.md §18: "the engine must be correct on any edge
  // multiset the indexer can emit," and a direct log scan is exactly that, an indexer of one. A
  // fresh Vouched resets revoked=false with a new issuedAt/expiresAt (handling a
  // revoke-then-vouch cycle correctly); a Reaffirmed only moves expiresAt forward; a Revoked only
  // sets the flag. Exactly one resolved record per pair reaches the caller — @aval/engine's own
  // (separate, redundant-safe) dedupeVouches() never has more than one record per pair to choose
  // between in the first place. ─────────────────────────────────────────────────────────────────
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
    issuedAt: bigint;
    expiresAt: bigint;
    revoked: boolean;
  }
  const pairState = new Map<string, PairState>();
  for (const ev of replay) {
    const key = pairKey(ev.args.voucher, ev.args.vouchee);
    if (ev.kind === "Vouched") {
      pairState.set(key, { issuedAt: ev.args.issuedAt!, expiresAt: ev.args.expiresAt!, revoked: false });
    } else if (ev.kind === "Reaffirmed") {
      const cur = pairState.get(key);
      if (cur) cur.expiresAt = ev.args.expiresAt!;
    } else if (ev.kind === "Revoked") {
      const cur = pairState.get(key);
      if (cur) cur.revoked = true;
    }
  }

  // ── active is a query-time predicate, not indexed state: not revoked AND not expired
  // (docs/01-trust-math.md §14, §18), evaluated against `atBlock`'s own timestamp. ───────────────
  const vouches: GraphVouch[] = [];
  for (const [key, state] of pairState) {
    const [voucherLower, voucheeLower] = key.split("::") as [string, string];
    if (!validIds.has(voucherLower) || !validIds.has(voucheeLower)) continue;
    const active = !state.revoked && now < Number(state.expiresAt);
    if (!active) continue;
    vouches.push({ voucherId: voucherLower, voucheeId: voucheeLower, issuedAt: state.issuedAt, expiresAt: state.expiresAt });
  }

  return {
    accounts,
    vouches,
    meta: { deploymentId: CHAIN_PROVENANCE, blockNumber: Number(atBlock) },
  };
}

// ── caching — by latest block number, short TTL (public RPCs rate-limit and lag; a burst of tool
// calls in one agent turn should not each pay for a fresh scan). ───────────────────────────────

const LATEST_BLOCK_TTL_MS = 4_000;
let latestBlockCache: { fetchedAt: number; block: bigint } | null = null;

async function getLatestBlockCached(): Promise<bigint> {
  const nowMs = Date.now();
  if (latestBlockCache && nowMs - latestBlockCache.fetchedAt < LATEST_BLOCK_TTL_MS) return latestBlockCache.block;
  const block = await getClient().getBlockNumber();
  latestBlockCache = { fetchedAt: nowMs, block };
  return block;
}

// docs/10-constants.md §5's "MCP verdict cache: 5 min max" is a ceiling, not a target; 5s matches
// the ENS gateway's own Subgraph TTL convention (docs/04-ens.md §3.2) and is purely to stop a
// burst of tool calls in one agent turn from each re-triggering a chain read.
const GRAPH_CACHE_TTL_MS = 5_000;
let graphCache: { fetchedAt: number; promise: Promise<TrustGraph> } | null = null;

/** The live trust graph at the latest block, cached briefly. */
export async function getCachedGraph(): Promise<TrustGraph> {
  const nowMs = Date.now();
  if (graphCache && nowMs - graphCache.fetchedAt < GRAPH_CACHE_TTL_MS) return graphCache.promise;
  const latest = await getLatestBlockCached();
  const promise = fetchGraphAtBlock(latest);
  graphCache = { fetchedAt: nowMs, promise };
  // Don't let a failed fetch poison the cache for subsequent calls.
  promise.catch(() => {
    if (graphCache?.promise === promise) graphCache = null;
  });
  return promise;
}

/** `fetchGraph()` (no args) is `getCachedGraph()`. `fetchGraph(atBlock)` bypasses the cache for a
 *  point-in-time historical read (aval_history's time-travel — docs/05-graph-data-layer.md §2.5),
 *  served from the same incremental log accumulator so repeat historical queries are cheap too. */
export async function fetchGraph(atBlock?: number): Promise<TrustGraph> {
  if (atBlock === undefined) return getCachedGraph();
  return fetchGraphAtBlock(BigInt(atBlock));
}

export function clearChainCache(): void {
  accumulator = null;
  graphCache = null;
  latestBlockCache = null;
}

// ── true live anchor check — bypasses the 5s trust-graph cache entirely (aval_anchor_status:
// "Never cached beyond 60s — anchor status is the ground truth of the whole trust graph," per
// docs/06-mcp-skills.md §2.9; the tool file itself applies that 60s cache, this function is
// always a fresh read). ─────────────────────────────────────────────────────────────────────────

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

export interface LiveAnchorCheck {
  isAnchor: boolean;
  anchorSource: LiveAnchorSource;
  contract: Address;
}

export async function checkAnchorStatusLive(address: Address): Promise<LiveAnchorCheck> {
  const client = getClient();
  const anchorBook = getAnchorBookAddress();
  const [isAnchor, anchorSource] = await Promise.all([
    client.readContract({ address: anchorBook, abi: GENESIS_ANCHOR_BOOK_ABI, functionName: "getIsUserVerified", args: [address] }),
    getAnchorSource(client, anchorBook),
  ]);
  return { isAnchor, anchorSource, contract: anchorBook };
}
