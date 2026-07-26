/**
 * app/src/lib/chain.ts
 *
 * The live data source: World Chain Sepolia, read directly with viem. No subgraph, no indexer —
 * this reads `Enrolled` / `Vouched` / `Reaffirmed` / `Revoked` logs from `VouchMeRegistry` straight
 * off the chain, resolves anchor status live from the Address Book's `addressVerifiedUntil` (never
 * cached into the scoring path — docs/03-worldid.md §3), and reads presence-drip state from
 * `PresenceDrip`. It assembles the exact `EngineInput` shape `@vouchme/engine` expects and hands the
 * caller that input plus the real `EngineOutput` from `compute()` — this module never formats a
 * score itself. Every number still comes from the engine (docs/01-trust-math.md).
 *
 * Server-only. Never imported from a "use client" component.
 */

import {
  createPublicClient,
  encodeAbiParameters,
  fallback,
  getAddress,
  http,
  keccak256,
  type AbiEvent,
  type Address,
  type Chain,
  type Hex,
  type Log,
  type PublicClient,
} from "viem";
import {
  compute,
  type Account,
  type EngineInput,
  type EngineOutput,
  type PlatformVouch,
  type Report,
  type ReportState,
  type Vouch,
} from "@vouchme/engine";

// ─── World Chain ──────────────────────────────────────────────────────────────────────────────
// Which World Chain this is, is a DEPLOYMENT fact, not a fixed property of the code: VouchMe runs on
// mainnet (480) because MiniKit will not broadcast anywhere else, and the Sepolia deployment
// (4801) still exists and still holds the trust-math scenario. Read from env so the data layer
// cannot point at a different chain than the rest of the app.
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

/** A tuning knob read from env, clamped to a range that cannot break the reader. An unset, empty or
 *  unparseable value falls back to `fallbackValue` rather than throwing: these are performance
 *  dials, and a typo in one must not take the whole app down the way a missing contract address
 *  rightly does. */
function envInt(name: string, fallbackValue: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallbackValue;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallbackValue;
  return Math.min(max, Math.max(min, parsed));
}

/** How many JSON-RPC requests may share one HTTP body. Bounded by the STRICTEST configured
 *  provider, not by viem's `batch: true` default of 1000: drpc.org's free plan rejects any batch
 *  over three with `{"code":31,"message":"Batch of more than 3 requests are not allowed on free
 *  plan"}` (HTTP 500), and it is the primary endpoint on some deployments. `1` turns array bodies
 *  off completely. */
const RPC_BATCH_SIZE = envInt("RPC_BATCH_SIZE", 3, 1, 100);

interface ChainConfig {
  /** Ordered, deduped; index 0 is primary, the rest are failover targets. */
  rpcUrls: string[];
  deploymentBlock: bigint;
  vouchMeRegistry: Address;
  genesisAnchorBook: Address;
  presenceDrip: Address;
  meAddress: Address;
  /** `null` when the deployment has no ReportRegistry configured. That is NOT the same as "there
   *  are no reports" and must never be rendered as one — `LiveGraph.reportsAvailable` carries the
   *  distinction all the way to the UI (see /reports). */
  reportRegistry: Address | null;
  /** `null` when the deployment has no PlatformRegistry configured — same distinction as above,
   *  carried by `LiveGraph.platformsAvailable`. */
  platformRegistry: Address | null;
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

/** One env value → the endpoints it names. A **comma-separated list** is accepted, so a single
 *  variable can carry a whole failover chain (`WORLDCHAIN_RPC=https://a.example,https://b.example`)
 *  instead of the deployment having to know this module's private list of alternative variable
 *  names. A plain single URL is just a list of one, so every existing single-value `.env` keeps
 *  working byte for byte and the endpoint that is configured today stays first. */
function splitEndpoints(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Every distinct URL among `names`, in order — NOT just the first one that happens to be set.
 *  These become a viem `fallback()` transport, so a provider that rate-limits under the burst of
 *  reads one page issues is routed around instead of failing the request.
 *
 *  Several names are accepted (`NEXT_PUBLIC_WORLDCHAIN_RPC`, this app's convention;
 *  `WORLDCHAIN_SEPOLIA_RPC`, the name every script under scripts/ and contracts/.env uses) so one
 *  RPC URL value works everywhere in the repo without being duplicated under unrelated names. */
function requireEnvAll(names: string[]): string[] {
  const urls: string[] = [];
  for (const name of names) {
    const v = process.env[name];
    if (!v) continue;
    for (const url of splitEndpoints(v)) if (!urls.includes(url)) urls.push(url);
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

/** Same as `requireAddress`, but returns `null` instead of throwing when the variable is unset —
 *  and, unlike `requireAddress`, tolerates a mis-cased (non-EIP-55) value.
 *
 *  Both differences are deliberate:
 *   - **Optional**: a deployment may genuinely have no ReportRegistry/PlatformRegistry, and the
 *     honest answer there is "not read", not a 503 for the whole app.
 *   - **Case-tolerant**: viem's `getAddress` rejects an address whose capitalisation is not the
 *     EIP-55 checksum, even when the 20 bytes are right. Lower-casing first re-derives the
 *     checksum from the address itself, so a cosmetic transcription slip in `.env` cannot silently
 *     switch reports off. */
function optionalAddress(name: string): Address | null {
  const raw = process.env[name];
  if (!raw) return null;
  try {
    return getAddress(raw.toLowerCase());
  } catch {
    throw new ChainConfigError(`${name}="${raw}" is not a valid address.`);
  }
}

/** Everything this module memoises, held in ONE object anchored on `globalThis`.
 *
 *  Not a style choice — plain module-level `let`s were silently per-bundle. Next.js compiles
 *  `instrumentation.ts` into its own webpack bundle, so the built output contains two copies of
 *  this module (confirmed in `.next/server/chunks`: instrumentation resolves chain.ts from one
 *  chunk id, `/api/identity/[id]` and `/api/score/[address]` from a different one). Two copies
 *  means two sets of module-level variables, so the boot-time warm-up filled a log accumulator and
 *  graph cache that **no request handler could ever read**. `[instrumentation] chain cache warm in
 *  6618ms` was true and useless: every request still paid a full cold scan from `DEPLOYMENT_BLOCK`.
 *
 *  `Symbol.for` is registry-global, so both bundles resolve the same key and share one store. It
 *  also survives `next dev`'s module-cache eviction on every file edit — the exact cold-start
 *  penalty instrumentation.ts's own doc comment set out to avoid. */
interface ChainState {
  config: ChainConfig | null;
  anchorSource: LiveAnchorSource | null;
  client: PublicClient | null;
  accumulator: LogAccumulator | null;
  accumulatorInFlight: Promise<void> | null;
  latestBlock: { fetchedAt: number; block: bigint } | null;
  graph: { fetchedAt: number; promise: Promise<LiveGraph> } | null;
}

const CHAIN_STATE_KEY = Symbol.for("vouchme.chain.state");

const state: ChainState = ((): ChainState => {
  const host = globalThis as typeof globalThis & { [CHAIN_STATE_KEY]?: ChainState };
  host[CHAIN_STATE_KEY] ??= {
    config: null,
    anchorSource: null,
    client: null,
    accumulator: null,
    accumulatorInFlight: null,
    latestBlock: null,
    graph: null,
  };
  return host[CHAIN_STATE_KEY];
})();

function getConfig(): ChainConfig {
  if (state.config) return state.config;
  state.config = {
    // Two rules govern this list, and they are independent of each other.
    //
    // 1. A URL carrying an API key belongs ONLY under a name without the NEXT_PUBLIC_ prefix.
    //    Next.js inlines every NEXT_PUBLIC_* value into the browser bundle, so a keyed provider
    //    URL under such a name publishes the key to every visitor. `WORLDCHAIN_RPC` is the
    //    server-only slot for a keyed endpoint; the NEXT_PUBLIC_ ones must stay keyless, because
    //    the client paths read them too (src/lib/worldchain.ts, src/lib/wallet.ts).
    //
    // 2. Order is failover order, and the primary has to be able to serve the read this module
    //    actually makes — a `getLogs` spanning every block since DEPLOYMENT_BLOCK, thousands of
    //    them. Metered free tiers routinely cap that: Alchemy's answers
    //    `{"code":-32600,"message":"Under the Free tier plan, you can make eth_getLogs requests
    //    with up to a 10 block range"}`. Such a provider is still worth keeping as a failover for
    //    the keyless providers' rate limits, but putting it first only spends a round trip
    //    failing before the fallback finds a provider that can answer.
    rpcUrls: requireEnvAll([
      "NEXT_PUBLIC_WORLDCHAIN_RPC",
      "WORLDCHAIN_RPC",
      "WORLDCHAIN_SEPOLIA_RPC",
      "NEXT_PUBLIC_WORLDCHAIN_RPC_FALLBACK",
    ]),
    deploymentBlock: BigInt(requireEnv("DEPLOYMENT_BLOCK")),
    vouchMeRegistry: requireAddress("VOUCHME_REGISTRY_ADDRESS"),
    genesisAnchorBook: requireAddress("GENESIS_ANCHOR_BOOK_ADDRESS"),
    presenceDrip: requireAddress("PRESENCE_DRIP_ADDRESS"),
    meAddress: requireAddress("ME_ADDRESS"),
    reportRegistry: optionalAddress("REPORT_REGISTRY_ADDRESS"),
    platformRegistry: optionalAddress("PLATFORM_REGISTRY_ADDRESS"),
  };
  return state.config;
}

/** Every contract address in play, for the `meta.contracts` envelope. Includes
 *  the ones this module doesn't read from (ReportRegistry, PlatformRegistry, CredibilityVault,
 *  VouchMeToken) so `meta` documents the full deployed set, not just the subset queried. */
export function getContractAddressSet(): Record<string, string> {
  const cfg = getConfig();
  const optional = (name: string): string | undefined => {
    const v = process.env[name];
    return v ? v : undefined;
  };
  const set: Record<string, string> = {
    VouchMeRegistry: cfg.vouchMeRegistry,
    GenesisAnchorBook: cfg.genesisAnchorBook,
    PresenceDrip: cfg.presenceDrip,
  };
  const reportRegistry = optional("REPORT_REGISTRY_ADDRESS");
  const platformRegistry = optional("PLATFORM_REGISTRY_ADDRESS");
  const credibilityVault = optional("CREDIBILITY_VAULT_ADDRESS");
  const vouchMeToken = optional("VOUCHME_TOKEN_ADDRESS");
  if (reportRegistry) set.ReportRegistry = reportRegistry;
  if (platformRegistry) set.PlatformRegistry = platformRegistry;
  if (credibilityVault) set.CredibilityVault = credibilityVault;
  if (vouchMeToken) set.VouchMeToken = vouchMeToken;
  return set;
}

/** NOT "me" — `ME_ADDRESS` is a technical fallback identity `buildLiveContext` needs to seed a
 *  graph context for pages that have no per-viewer concept at all (Explore, Platform), never
 *  a stand-in for a signed-in user. Every page that shows "your" data (Home, the enroll/vouch
 *  wizards) always passes a real, cookie-sourced `viewingAddress` instead — see `AppGate` and
 *  `page.tsx`'s own doc comment. */
export function getDemoAddress(): Address {
  return getConfig().meAddress;
}

/** Server-only accessors for the two addresses `src/lib/attestation.ts` needs to build EIP-712
 *  domains for (VouchMeRegistry, PresenceDrip). Kept alongside the rest of `getConfig()`'s callers
 *  rather than re-reading `process.env` a second time. */
export function getVouchMeRegistryAddressServer(): Address {
  return getConfig().vouchMeRegistry;
}

export function getPresenceDripAddressServer(): Address {
  return getConfig().presenceDrip;
}

/** The EIP-712 verifying contract for a `ReportAttestation`. `null` when this deployment has no
 *  ReportRegistry — `/api/report/attest` then refuses to sign rather than signing for an address
 *  it guessed. */
export function getReportRegistryAddressServer(): Address | null {
  return getConfig().reportRegistry;
}

export function getPlatformRegistryAddressServer(): Address | null {
  return getConfig().platformRegistry;
}

// anchorSource() is declared `pure` on GenesisAnchorBook — it returns a compile-time constant and
// can never change for a given deployment, so it is fetched once per process.
async function getAnchorSource(client: PublicClient, book: Address): Promise<LiveAnchorSource> {
  if (state.anchorSource !== null) return state.anchorSource;
  // Decided by WHICH contract is configured, not by whether a call happened to fail. The real
  // Address Book has no anchorSource(), so asking it would revert — but a revert alone must never
  // be read as "these are Orb anchors."
  if (isWorldIdAddressBook(book)) {
    state.anchorSource = "world-id-orb";
    return state.anchorSource;
  }
  state.anchorSource = assertKnownAnchorSource(
    await client.readContract({
      address: book,
      abi: GENESIS_ANCHOR_BOOK_ABI,
      functionName: "anchorSource",
    }),
  );
  return state.anchorSource;
}

// ─── malformed batch replies — the failure this module exists to not mistranslate ───────────────

/** A provider answered a JSON-RPC **batch** (an array body) with something that is not an array.
 *
 *  This has its own error type because viem structurally cannot report it. Its HTTP client returns
 *  a non-2xx body verbatim whenever that body merely *looks* like a JSON-RPC error
 *  (`utils/rpc/http.ts`: "If the response body contains a valid JSON-RPC error, return it"), without
 *  checking that a batch request got a batch response. `createBatchScheduler` then hands caller *i*
 *  `data[i]`, which on a bare object is `undefined` for every caller, and
 *  `clients/transports/http.ts` destructures it — `const [{ error, result }] = await fn(body)` —
 *  producing `TypeError: Cannot read properties of undefined (reading 'error')` wrapped in
 *  `UnknownRpcError`. That reaches the UI as `chain_unavailable`: "Can't reach World Chain right
 *  now", for a provider that is healthy and merely throttling us.
 *
 *  Observed verbatim from a configured endpoint, in reply to an 8-element batch:
 *
 *      HTTP 429  {"id":1,"jsonrpc":"2.0","error":{"code":-32005,"message":"rate limit exceeded"}}
 *
 *  The size of the batch is irrelevant — a rate-limited batch of three answers the same way — so
 *  capping the batch size reduces how often this is reached but cannot remove it. Only refusing to
 *  hand viem a reply it cannot read does that. Raised as a normal transport failure so viem's
 *  `fallback()` routes to the next endpoint instead of dying on the last one. */
export class MalformedRpcResponseError extends Error {
  constructor(
    readonly rpcUrl: string,
    readonly status: number,
    readonly requestCount: number,
    readonly rawBody: string,
  ) {
    super(
      `${rpcHost(rpcUrl)} answered a JSON-RPC batch of ${requestCount} with a non-array body ` +
        `(HTTP ${status}), which viem reads positionally and cannot decode. Raw body: ` +
        `${rawBody.slice(0, RAW_BODY_LOG_LIMIT)}`,
    );
    this.name = "MalformedRpcResponseError";
  }
}

const RAW_BODY_LOG_LIMIT = 400;

function rpcHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** True for a body viem will send as a JSON-RPC batch (an array). Checked by first character
 *  rather than `JSON.parse`, so the common path costs nothing. */
function isBatchBody(body: BodyInit | null | undefined): boolean {
  return typeof body === "string" && body.trimStart().startsWith("[");
}

/** Walks the `cause` chain for a `MalformedRpcResponseError`, which viem wraps in
 *  `HttpRequestError` on its way out of the transport. */
export function findMalformedRpcResponse(err: unknown): MalformedRpcResponseError | null {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 10; e = e.cause, depth++) {
    if (e instanceof MalformedRpcResponseError) return e;
  }
  return null;
}

/** `fetch` for the RPC transports, which refuses to hand viem a batch reply it cannot read.
 *
 *  Non-batch requests are passed straight through untouched — no extra buffering, no behaviour
 *  change. A batch request's body is read once here and re-attached to an equivalent `Response`
 *  (rather than `clone()`d, which would buffer it twice), so viem sees exactly what the provider
 *  sent whenever the shape is legal. `content-encoding`/`content-length` are dropped because the
 *  text has already been decoded, and leaving them would describe the wire bytes, not this body. */
async function guardedRpcFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, init);
  if (!isBatchBody(init?.body)) return response;

  const text = await response.text();
  if (text.trimStart().startsWith("[")) {
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(text, { status: response.status, statusText: response.statusText, headers });
  }

  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let requestCount = 0;
  try {
    const parsed: unknown = JSON.parse(String(init?.body));
    if (Array.isArray(parsed)) requestCount = parsed.length;
  } catch {
    // The count is for the message only; a body we cannot re-parse still gets reported.
  }
  const err = new MalformedRpcResponseError(url, response.status, requestCount, text);
  console.warn(`[chain] ${err.message}`);
  throw err;
}

function getClient(): PublicClient {
  if (state.client) return state.client;
  const cfg = getConfig();
  state.client = createPublicClient({
    chain: worldChain(cfg.rpcUrls),
    // Aggregate concurrent eth_calls into Multicall3 instead of firing one request per account.
    //
    // Without this, each fetch issues roughly 3N+1 separate eth_calls — the anchor read, members()
    // and the presence tuple, once per account, plus anchorSource() — enough to trip a public
    // RPC's rate limit on an uncached load. Reading anchors live is a correctness requirement
    // (docs/03-worldid.md §3); reading them one HTTP request at a time never was. Multicall3 keeps
    // the reads live and at a single block, while collapsing them into one or two requests.
    //
    // Multicall3 is at the canonical address on World Chain Sepolia — verified on chain, not
    // assumed from it being an OP-stack chain.
    batch: {
      multicall: { batchSize: 1024, wait: 16 },
    },
    // Public RPCs rate-limit (429) under load — retry with backoff instead of surfacing a
    // transient throttle as "the chain is broken." A sustained outage still surfaces: retries
    // are bounded, and getLiveGraph()/getChainHealth() let a final failure propagate as a real
    // error rather than falling back to fixtures.
    // `fallback` over every configured URL, not just the first: retries alone cannot rescue a
    // throttled provider, because the next attempt hits the same rate-limited host, and an
    // empty-bodied 429 surfaces as `chain_unavailable` when that provider is the only provider.
    // `rank: false` keeps declared order (env order is intent).
    // JSON-RPC batch size is capped at what the strictest configured provider accepts, NOT left
    // at viem's `batch: true` default of 1000. drpc.org's free plan rejects any batch over three
    // requests — `{"code":31,"message":"Batch of more than 3 requests are not allowed on free
    // plan"}`, served as HTTP 500 with a JSON *array* body. Because that body is an array,
    // `data.error` is undefined in viem's HTTP client, so it never becomes a typed RPC error and
    // instead escapes as `Cannot read properties of undefined (reading 'error')` inside
    // UnknownRpcError — i.e. this app's `chain_unavailable`, which reads as "World Chain is down"
    // for what is only a batch three requests too long.
    //
    // It cannot be caught locally: `wait: 0` batches whatever is queued in the same tick, and a
    // warm dev machine coalesces two or three reads where a cold serverless invocation coalesces
    // a dozen. The failure was reproducible only on Vercel. Bounding the batch (over a 16ms
    // window, matching the multicall window above) keeps every provider inside its limit, and the
    // multicall batching above is what actually collapses the per-account reads anyway.
    //
    // Capping the batch is necessary but NOT sufficient, and the difference matters: a provider
    // that rate-limits a batch of three answers it with a single bare object just as readily as a
    // batch of eight (measured, not assumed). `guardedRpcFetch` is what actually closes that hole —
    // see `MalformedRpcResponseError`. `RPC_BATCH_SIZE=1` disables array bodies entirely, which is
    // the setting to reach for if a future provider mishandles batches in some new way.
    transport: fallback(
      cfg.rpcUrls.map((url) =>
        http(url, {
          retryCount: 3,
          retryDelay: 750,
          fetchFn: guardedRpcFetch,
          batch: RPC_BATCH_SIZE > 1 ? { batchSize: RPC_BATCH_SIZE, wait: 16 } : false,
        }),
      ),
      { rank: false, retryCount: 2 },
    ),
  });
  return state.client;
}

// ─── ABI fragments — exactly the surface this module reads, matching subgraph/abis/VouchMeRegistry
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

const VOUCHME_REGISTRY_ABI = [
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
    // The real World ID Address Book has NO `getIsUserVerified` — that call reverts. It stores an
    // EXPIRY (`addressVerifiedUntil`), because Orb verification lapses unless renewed. The testnet
    // stand-in matches this shape.
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

// ─── ReportRegistry / PlatformRegistry — the reporting half of the graph ────────────────────────
// Only `ReportFiled` / `PlatformRegistered` / `PlatformVouched` / `PlatformVouchRevoked` /
// `ScoreRequested` are scanned as LOGS. Everything mutable about a report (state, resolvedAt,
// rebuttals) is then read from the contract's own `reports(id)` getter rather than replayed from
// `Resolved`/`Escalated`/`Rebutted` events: the struct is the authority, it is one multicall-batched
// read per report, and it cannot drift from a state transition whose event this module forgot to
// handle. The logs exist to enumerate ids (and to date the filing — `ReportFiled` carries no
// timestamp, so `filedAt` comes from the struct too).

const REPORT_FILED_EVENT = {
  type: "event",
  name: "ReportFiled",
  anonymous: false,
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "reporter", type: "address", indexed: true },
    { name: "target", type: "address", indexed: true },
    { name: "weightPoints", type: "uint32", indexed: false },
    { name: "bond", type: "uint128", indexed: false },
    { name: "evidenceHash", type: "bytes32", indexed: false },
  ],
} as const satisfies AbiEvent;

const PLATFORM_REGISTERED_EVENT = {
  type: "event",
  name: "PlatformRegistered",
  anonymous: false,
  inputs: [
    { name: "platform", type: "address", indexed: true },
    { name: "ensName", type: "string", indexed: false },
    { name: "bond", type: "uint128", indexed: false },
  ],
} as const satisfies AbiEvent;

const PLATFORM_VOUCHED_EVENT = {
  type: "event",
  name: "PlatformVouched",
  anonymous: false,
  inputs: [
    { name: "human", type: "address", indexed: true },
    { name: "platform", type: "address", indexed: true },
    { name: "expiresAt", type: "uint64", indexed: false },
  ],
} as const satisfies AbiEvent;

const PLATFORM_VOUCH_REVOKED_EVENT = {
  type: "event",
  name: "PlatformVouchRevoked",
  anonymous: false,
  inputs: [
    { name: "human", type: "address", indexed: true },
    { name: "platform", type: "address", indexed: true },
  ],
} as const satisfies AbiEvent;

const SCORE_REQUESTED_EVENT = {
  type: "event",
  name: "ScoreRequested",
  anonymous: false,
  inputs: [
    { name: "id", type: "bytes32", indexed: true },
    { name: "platform", type: "address", indexed: true },
    { name: "subject", type: "address", indexed: true },
    { name: "purposeHash", type: "bytes32", indexed: false },
    { name: "at", type: "uint64", indexed: false },
  ],
} as const satisfies AbiEvent;

const REPORT_REGISTRY_ABI = [
  REPORT_FILED_EVENT,
  {
    type: "function",
    name: "reports",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [
      { name: "reporter", type: "address" },
      { name: "target", type: "address" },
      { name: "evidenceHash", type: "bytes32" },
      { name: "weightPoints", type: "uint32" },
      { name: "bond", type: "uint128" },
      { name: "filedAt", type: "uint64" },
      { name: "resolvedAt", type: "uint64" },
      { name: "rebuttalTotal", type: "uint128" },
      { name: "rebutterCount", type: "uint8" },
      { name: "state", type: "uint8" },
    ],
  },
  {
    type: "function",
    name: "openReportCount",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint32" }],
  },
  {
    type: "function",
    name: "lastReportAt",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "voided",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "attestors",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const PLATFORM_REGISTRY_ABI = [
  PLATFORM_REGISTERED_EVENT,
  PLATFORM_VOUCHED_EVENT,
  PLATFORM_VOUCH_REVOKED_EVENT,
  SCORE_REQUESTED_EVENT,
  {
    type: "function",
    name: "platforms",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [
      { name: "ensName", type: "string" },
      { name: "metadataURI", type: "bytes32" },
      { name: "policyURI", type: "bytes32" },
      { name: "bond", type: "uint128" },
      { name: "registeredAt", type: "uint64" },
      { name: "openReports", type: "uint32" },
      { name: "active", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "platformVouches",
    stateMutability: "view",
    inputs: [
      { name: "", type: "address" },
      { name: "", type: "address" },
    ],
    outputs: [
      { name: "issuedAt", type: "uint64" },
      { name: "expiresAt", type: "uint64" },
      { name: "revoked", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "scoreRequests",
    stateMutability: "view",
    inputs: [{ name: "", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isRegistered",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** GenesisAnchorBook is honest by contract design (contracts/script/GenesisAnchorBook.sol's own
 *  doc comment): `anchorSource()` returns "genesis-testnet", never "world-id-orb". This module
 *  reads that value live rather than assuming it, and refuses to guess a label if it's ever
 *  anything else — presenting a genesis anchor as an Orb anchor would forge the one
 *  externally-grounded fact in the protocol. */
export type LiveAnchorSource = "genesis-testnet" | "world-id-orb";

/** World ID's real Address Book. It exists on World Chain MAINNET only — which is the entire
 *  reason `GenesisAnchorBook` was written as a testnet stand-in
 *  (deployments/worldchain-mainnet.json). */
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

// ─── log fetching, chunked — public RPCs cap the block range per eth_getLogs call. ───────────────

// The public Alchemy RPC caps eth_getLogs at 100 blocks per call (scripts/live-verify.mjs uses the
// same value for the same reason).
const LOG_CHUNK_BLOCKS = BigInt(100);

// How many chunk requests are in flight at once, across the WHOLE module — not per call.
//
// This used to be a per-call worker pool, which quietly meant nine of them: `ensureLogsThrough`
// scans nine event types in one `Promise.all`, so a pool of 8 each allowed up to 72 concurrent
// `eth_getLogs`, plus the per-account multicalls on top. That burst is self-inflicted rate
// limiting — public endpoints start 429ing well below it (measured: roughly a third of 80
// concurrent requests to one configured provider) — and a throttled batch is exactly what provokes
// the malformed reply `MalformedRpcResponseError` documents. A single shared semaphore makes the
// fan-out a property of this module rather than a multiple of how many event types it happens to
// scan.
const LOG_SCAN_CONCURRENCY = envInt("LOG_SCAN_CONCURRENCY", 4, 1, 64);

let scanInFlight = 0;
const scanQueue: Array<() => void> = [];

/** Hands the slot straight to the next waiter rather than decrementing and letting a newcomer race
 *  in ahead of it, so the ceiling is exact and the queue stays FIFO. */
function releaseScanSlot(): void {
  const next = scanQueue.shift();
  if (next) {
    next();
    return;
  }
  scanInFlight--;
}

async function withScanSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (scanInFlight >= LOG_SCAN_CONCURRENCY) {
    await new Promise<void>((resolve) => scanQueue.push(resolve));
  } else {
    scanInFlight++;
  }
  try {
    return await fn();
  } finally {
    releaseScanSlot();
  }
}

// The 100-block cap is Alchemy's, not the chain's — other configured providers serve 10 000-block
// ranges happily. So: ask for a wide range first, and narrow to 100 ONLY for the ranges that are
// actually refused. Against a wide-range provider the historical scan collapses to a handful of
// requests; against Alchemy it degrades to a per-100-block scan. Neither provider is assumed — the
// code discovers which it is talking to from the error it gets back.
const LOG_CHUNK_BLOCKS_WIDE = BigInt(envInt("LOG_SCAN_CHUNK_BLOCKS", 10_000, 100, 100_000));

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
    // `chain_unavailable` while the chain is perfectly healthy. Verbatim examples:
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
      return await withScanSlot(() => client.getLogs({ address, event, fromBlock: from, toBlock: to }));
    } catch (err) {
      // Name the provider AND the range before this becomes a generic 503. Someone told "we
      // couldn't confirm your account" is owed a server log that says which endpoint failed on
      // which blocks, not a stack trace about `undefined`.
      const malformed = findMalformedRpcResponse(err);
      if (malformed) {
        console.warn(
          `[chain] ${event.name} scan ${from}-${to} on ${address} failed: ` +
            `${rpcHost(malformed.rpcUrl)} returned an unreadable batch reply (HTTP ${malformed.status}). ` +
            `Falling back to the next configured endpoint.`,
        );
      }
      if (!isBlockRangeError(err) || to - from < LOG_CHUNK_BLOCKS) throw err;
      const narrow: Log[] = [];
      for (let f = from; f <= to; ) {
        const end = f + LOG_CHUNK_BLOCKS - BigInt(1);
        const t = end > to ? to : end;
        narrow.push(
          ...(await withScanSlot(() => client.getLogs({ address, event, fromBlock: f, toBlock: t }))),
        );
        f = t + BigInt(1);
      }
      return narrow;
    }
  }

  // Concurrency is bounded globally by `withScanSlot`, so every range can be launched at once and
  // re-assembled in block order — `getLogs` results must stay ordered, since downstream code treats
  // vouch/revoke sequence as meaningful.
  const results = await Promise.all(ranges.map((r) => fetchRange(r.from, r.to)));
  return results.flat();
}

// ─── incremental log accumulation ─────────────────────────────────────────────────────────────
// World Chain Sepolia produces a new block roughly every second or two, which would make a naive
// "rescan every event from the deployment block on every cache miss" approach re-fetch a growing,
// unbounded history on almost every request, which public RPCs answer with rate limits and lag.
// Instead, remember how far we've scanned and only ever fetch the
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
  /** ReportRegistry `ReportFiled` — the id set. Empty array when no ReportRegistry is configured;
   *  `LiveGraph.reportsAvailable` (not this array's length) is what says whether we asked. */
  reportFiledLogs: Log[];
  platformRegisteredLogs: Log[];
  platformVouchedLogs: Log[];
  platformVouchRevokedLogs: Log[];
  scoreRequestedLogs: Log[];
}

async function ensureLogsThrough(
  client: PublicClient,
  vouchMeRegistry: Address,
  reportRegistry: Address | null,
  platformRegistry: Address | null,
  deploymentBlock: bigint,
  upToBlock: bigint,
): Promise<LogAccumulator> {
  if (!state.accumulator) {
    state.accumulator = {
      scannedThrough: deploymentBlock - BigInt(1),
      enrolledLogs: [],
      vouchedLogs: [],
      reaffirmedLogs: [],
      revokedLogs: [],
      reportFiledLogs: [],
      platformRegisteredLogs: [],
      platformVouchedLogs: [],
      platformVouchRevokedLogs: [],
      scoreRequestedLogs: [],
    };
  }
  if (upToBlock <= state.accumulator.scannedThrough) return state.accumulator;

  if (!state.accumulatorInFlight) {
    const acc = state.accumulator;
    const from = acc.scannedThrough + BigInt(1);
    const to = upToBlock;
    const none = async (): Promise<Log[]> => [];
    state.accumulatorInFlight = (async () => {
      const [
        newEnrolled,
        newVouched,
        newReaffirmed,
        newRevoked,
        newReportFiled,
        newPlatformRegistered,
        newPlatformVouched,
        newPlatformVouchRevoked,
        newScoreRequested,
      ] = await Promise.all([
        getLogsChunked(client, vouchMeRegistry, ENROLLED_EVENT, from, to),
        getLogsChunked(client, vouchMeRegistry, VOUCHED_EVENT, from, to),
        getLogsChunked(client, vouchMeRegistry, REAFFIRMED_EVENT, from, to),
        getLogsChunked(client, vouchMeRegistry, REVOKED_EVENT, from, to),
        reportRegistry ? getLogsChunked(client, reportRegistry, REPORT_FILED_EVENT, from, to) : none(),
        platformRegistry ? getLogsChunked(client, platformRegistry, PLATFORM_REGISTERED_EVENT, from, to) : none(),
        platformRegistry ? getLogsChunked(client, platformRegistry, PLATFORM_VOUCHED_EVENT, from, to) : none(),
        platformRegistry ? getLogsChunked(client, platformRegistry, PLATFORM_VOUCH_REVOKED_EVENT, from, to) : none(),
        platformRegistry ? getLogsChunked(client, platformRegistry, SCORE_REQUESTED_EVENT, from, to) : none(),
      ]);
      acc.enrolledLogs.push(...newEnrolled);
      acc.vouchedLogs.push(...newVouched);
      acc.reaffirmedLogs.push(...newReaffirmed);
      acc.revokedLogs.push(...newRevoked);
      acc.reportFiledLogs.push(...newReportFiled);
      acc.platformRegisteredLogs.push(...newPlatformRegistered);
      acc.platformVouchedLogs.push(...newPlatformVouched);
      acc.platformVouchRevokedLogs.push(...newPlatformVouchRevoked);
      acc.scoreRequestedLogs.push(...newScoreRequested);
      acc.scannedThrough = to;
    })().finally(() => {
      state.accumulatorInFlight = null;
    });
  }
  await state.accumulatorInFlight;
  // Another caller may have asked for a still-newer block while we were fetching; catch up.
  return ensureLogsThrough(client, vouchMeRegistry, reportRegistry, platformRegistry, deploymentBlock, upToBlock);
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
  /** Unix seconds of this account's last `vouch()`. `VouchMeRegistry` reverts with `RateLimited()`
   *  within 24h of it, so the UI needs it to refuse a vouch that cannot succeed and to show a real
   *  countdown rather than a fixed "24h". */
  lastVouchAt: number;
  enrolled: boolean;
  fraudulent: boolean;
}

export interface PresenceInfo {
  lastClaimAt: number;
  epochsClaimed: number;
  accrualPausedUntil: number;
}

/** `ReportRegistry.State`, by name. Index = the on-chain enum value; do not reorder — this array
 *  IS the decoding of the `uint8` the struct getter returns (contracts/src/ReportRegistry.sol:38). */
const ON_CHAIN_REPORT_STATES = [
  "NONE",
  "PENDING",
  "ARBITRATION",
  "UPHELD",
  "UNPROVEN",
  "MALICIOUS",
  "WITHDRAWN",
] as const;

export type OnChainReportState = (typeof ON_CHAIN_REPORT_STATES)[number];

/** Everything about one on-chain report that the engine does NOT model but the UI needs to tell the
 *  truth about it: when it was filed, what it cost, which of the four verdicts it reached, and
 *  which transaction to point a person at. The engine deliberately reduces all of this to
 *  `{state, upheldAt, snapshotWeight}` (engine/src/types.ts:52) — the scoring math has no use for a
 *  bond or a tx hash, and this module never lets UI needs leak back into the scoring path. */
export interface ReportMeta {
  /** The `bytes32` report id, lower-cased hex — the key the engine's `reportWeights` uses too. */
  id: string;
  reporter: Address;
  target: Address;
  evidenceHash: Hex;
  /** As recorded on chain at filing. Centi-points, 1:1 with the engine's `snapshotWeight` — see
   *  `toEngineReports` for why no unit conversion happens here. */
  weightPoints: number;
  /** VOUCHME wei locked in `CredibilityVault` for this report (`10e18 × weightPoints`). */
  bond: bigint;
  filedAt: number;
  /** 0 on chain while the report is unresolved; `null` here, so "not resolved" can never be read
   *  as "resolved at the epoch". */
  resolvedAt: number | null;
  state: OnChainReportState;
  rebuttalTotal: bigint;
  rebutterCount: number;
  /** The transaction that filed it — real, verifiable, and the thing a person can click. */
  txHash: Hex;
}

export interface PlatformInfo {
  address: Address;
  ensName: string;
  bond: bigint;
  registeredAt: number;
  openReports: number;
  active: boolean;
}

export interface LiveGraph {
  block: bigint;
  now: number; // unix seconds — the latest block's own timestamp
  engineInput: EngineInput;
  engineOutput: EngineOutput;
  /** address -> the `handle` string it enrolled with (e.g. "carol.vouchme.eth"). The best display
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
  /** False when this deployment has no `REPORT_REGISTRY_ADDRESS` configured — i.e. the question
   *  was never asked. `reports: []` then means "we didn't look", and the UI must say so rather
   *  than render "nothing has been filed against you". True means ReportRegistry was scanned and
   *  an empty list really is an empty list. */
  reportsAvailable: boolean;
  /** Same distinction for PlatformRegistry: platform scores, platform vouches and the
   *  `ScoreRequest` precondition on platform reports are all unread when this is false. */
  platformsAvailable: boolean;
  /** report id (lower-cased hex) -> the on-chain record behind `engineInput.reports`. */
  reportMeta: Map<string, ReportMeta>;
  /** platform address -> its PlatformRegistry record. Empty when `platformsAvailable` is false. */
  platforms: Map<Address, PlatformInfo>;
}

function pairKey(voucher: Address, vouchee: Address): string {
  return `${voucher.toLowerCase()}::${vouchee.toLowerCase()}`;
}

async function fetchLiveGraph(atBlock: bigint): Promise<LiveGraph> {
  const client = getClient();
  const cfg = getConfig();

  const block = await client.getBlock({ blockNumber: atBlock });
  const now = Number(block.timestamp);

  const {
    enrolledLogs,
    vouchedLogs,
    reaffirmedLogs,
    revokedLogs,
    reportFiledLogs,
    platformRegisteredLogs,
    platformVouchedLogs,
    platformVouchRevokedLogs,
    scoreRequestedLogs,
  } = await ensureLogsThrough(
    client,
    cfg.vouchMeRegistry,
    cfg.reportRegistry,
    cfg.platformRegistry,
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
  // express.
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

  // ── VouchMeRegistry.members: activeOutbound (slots), credential window, enrolled/fraudulent ──────
  const memberTuples = await Promise.all(
    addresses.map((addr) =>
      client.readContract({ address: cfg.vouchMeRegistry, abi: VOUCHME_REGISTRY_ABI, functionName: "members", args: [addr] }),
    ),
  );
  const members = new Map<Address, MemberInfo>(
    addresses.map((addr, i) => {
      const [enrolledAt, credentialExpiresAt, activeOutbound, lastVouchAt, , , enrolled, fraudulent] =
        memberTuples[i]!;
      return [
        addr,
        {
          enrolledAt: Number(enrolledAt),
          credentialExpiresAt: Number(credentialExpiresAt),
          activeOutbound: Number(activeOutbound),
          lastVouchAt: Number(lastVouchAt),
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
  // replaying a log. We do NOT trust VouchMeRegistry's own `VouchExists` uniqueness check to protect
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

  // ── platforms: PlatformRegistry.PlatformRegistered gives the address set; the live record comes
  // from `platforms(address)` so a later deregistration (`active = false`) is seen, which no event
  // replay of `PlatformRegistered` alone could tell us. ──────────────────────────────────────────
  const platformAddresses = [
    ...new Set(
      (platformRegisteredLogs as unknown as Array<{ args: { platform: Address } }>).map((l) => l.args.platform),
    ),
  ];
  const platformTuples = cfg.platformRegistry
    ? await Promise.all(
        platformAddresses.map((addr) =>
          client.readContract({
            address: cfg.platformRegistry!,
            abi: PLATFORM_REGISTRY_ABI,
            functionName: "platforms",
            args: [addr],
          }),
        ),
      )
    : [];
  const platforms = new Map<Address, PlatformInfo>(
    platformAddresses.map((addr, i) => {
      const [ensName, , , bond, registeredAt, openReports, active] = platformTuples[i]!;
      return [
        addr,
        {
          address: addr,
          ensName,
          bond,
          registeredAt: Number(registeredAt),
          openReports: Number(openReports),
          active,
        },
      ];
    }),
  );

  /** Canonical spelling of an address that already appears in the graph, so an id read out of a
   *  contract getter can never fail to match an id read out of an event log by capitalisation
   *  alone. The engine keys everything by exact string (`accountsById`), so a mismatch would not
   *  be cosmetic: it would silently void every report as `reporter_unknown`/`target_unknown`. */
  const canonical = (addr: Address): Address => addrByLower.get(addr.toLowerCase()) ?? addr;

  // ── platform vouches: human → platform, `active` resolved the same query-time way vouches are
  // (docs/05-graph-data-layer.md §2.3). Read from `platformVouches(human, platform)` rather than
  // replayed from events, for the same reason as reports. ────────────────────────────────────────
  const platformVouchPairs = [
    ...new Map(
      [
        ...(platformVouchedLogs as unknown as Array<{ args: { human: Address; platform: Address } }>),
        ...(platformVouchRevokedLogs as unknown as Array<{ args: { human: Address; platform: Address } }>),
      ].map((l) => [`${l.args.human.toLowerCase()}::${l.args.platform.toLowerCase()}`, l.args] as const),
    ).values(),
  ];
  const platformVouchTuples = cfg.platformRegistry
    ? await Promise.all(
        platformVouchPairs.map((p) =>
          client.readContract({
            address: cfg.platformRegistry!,
            abi: PLATFORM_REGISTRY_ABI,
            functionName: "platformVouches",
            args: [p.human, p.platform],
          }),
        ),
      )
    : [];
  const platformVouches: PlatformVouch[] = platformVouchPairs.map((p, i) => {
    const [, expiresAt, revoked] = platformVouchTuples[i]!;
    return {
      voucher: canonical(p.human),
      platform: canonical(p.platform),
      active: !revoked && now < Number(expiresAt),
    };
  });

  // ── the `ScoreRequest` precondition (docs/13-platforms.md §5, docs/01-trust-math.md §7.3): a
  // platform may only report a subject it has previously looked up. `ReportRegistry.file` enforces
  // it on chain (`NoScoreRequest`), and the engine independently voids a platform report whose
  // `queried` is not true — so this set must be read, not assumed. ───────────────────────────────
  const scoreRequestKeys = new Set(
    (scoreRequestedLogs as unknown as Array<{ args: { platform: Address; subject: Address } }>).map(
      (l) => `${l.args.platform.toLowerCase()}::${l.args.subject.toLowerCase()}`,
    ),
  );

  // ── reports ──────────────────────────────────────────────────────────────────────────────────
  const reportIds = [
    ...new Set((reportFiledLogs as unknown as Array<{ args: { id: Hex } }>).map((l) => l.args.id.toLowerCase() as Hex)),
  ];
  const txHashById = new Map<string, Hex>(
    (reportFiledLogs as unknown as Array<{ args: { id: Hex }; transactionHash: Hex }>).map((l) => [
      l.args.id.toLowerCase(),
      l.transactionHash,
    ]),
  );
  const reportTuples = cfg.reportRegistry
    ? await Promise.all(
        reportIds.map((id) =>
          client.readContract({
            address: cfg.reportRegistry!,
            abi: REPORT_REGISTRY_ABI,
            functionName: "reports",
            args: [id],
          }),
        ),
      )
    : [];
  const reportMeta = new Map<string, ReportMeta>(
    reportIds.map((id, i) => {
      const [reporter, target, evidenceHash, weightPoints, bond, filedAt, resolvedAt, rebuttalTotal, rebutterCount, state] =
        reportTuples[i]!;
      const stateName = ON_CHAIN_REPORT_STATES[state];
      if (stateName === undefined) {
        // The enum has 7 members; an eighth would mean this ABI no longer matches the deployed
        // contract. Guessing a state here would mis-score someone, so refuse.
        throw new Error(`ReportRegistry.reports(${id}).state = ${state}, which this ABI does not know.`);
      }
      return [
        id,
        {
          id,
          reporter: canonical(reporter),
          target: canonical(target),
          evidenceHash,
          weightPoints: Number(weightPoints),
          bond,
          filedAt: Number(filedAt),
          resolvedAt: resolvedAt === BigInt(0) ? null : Number(resolvedAt),
          state: stateName,
          rebuttalTotal,
          rebutterCount: Number(rebutterCount),
          txHash: txHashById.get(id) ?? ("0x" as Hex),
        },
      ];
    }),
  );

  const platformIdSet = new Set(platformAddresses.map((a) => a.toLowerCase()));
  const reports: Report[] = [...reportMeta.values()].map((m) => toEngineReport(m, platformIdSet, scoreRequestKeys));

  const accounts: Account[] = [
    ...addresses.map((addr): Account => ({
      id: addr,
      kind: "human",
      isAnchor: isAnchorFor.get(addr) ?? false,
      epochsClaimed: presence.get(addr)?.epochsClaimed ?? 0,
      active: true,
    })),
    // A deregistered platform stays in the graph as `active: false` rather than vanishing: the
    // engine then voids its reports with `reporter_unknown` instead of scoring edges from an
    // account that no longer exists, and nothing downstream has to special-case a dangling id.
    ...[...platforms.values()].map((p): Account => ({ id: p.address, kind: "platform", active: p.active })),
  ];

  const engineInput: EngineInput = { now, accounts, vouches, platformVouches, reports };
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
    reportsAvailable: cfg.reportRegistry !== null,
    platformsAvailable: cfg.platformRegistry !== null,
    reportMeta,
    platforms,
  };
}

/**
 * One on-chain report record → the engine's `Report`.
 *
 * Three mappings that are easy to get wrong, all of them load-bearing:
 *
 * 1. **`weightPoints` → `snapshotWeight`, 1:1, no scaling.** Both are centi-points. The Subgraph
 *    does exactly this (`subgraph/src/report-registry.ts`: `report.snapshotWeight =
 *    event.params.weightPoints.toI32()`), and the two names differ only because the contract ABI
 *    and docs/01-trust-math.md §7.1 chose different words for the same quantity. Multiplying by
 *    100 "to convert to centi-points" would inflate every report's damage a hundredfold; dividing
 *    would silently zero it.
 * 2. **The seven-state on-chain enum → the engine's four.** ARBITRATION collapses into `pending`
 *    (engine/src/types.ts:46 — "no report weight until a terminal state is reached"), UNPROVEN and
 *    MALICIOUS both collapse into `rejected` (neither damages the target), WITHDRAWN stays
 *    distinct because docs/12-reporting.md §4 prices it differently for the reporter (10% burn).
 * 3. **`upheldAt` is mandatory for an upheld report.** `compute()` throws rather than let a
 *    missing timestamp make a report immortal (it drives both §7.4 decay and the 180-day
 *    reporter-voiding window). `resolvedAt` is the timestamp `resolve()`/`juryVote` wrote in the
 *    same transaction that set the state, so it is exactly that value — and if it is somehow 0, we
 *    surface the contradiction instead of substituting the epoch.
 */
function toEngineReport(m: ReportMeta, platformIds: ReadonlySet<string>, scoreRequestKeys: ReadonlySet<string>): Report {
  const state: ReportState =
    m.state === "PENDING" || m.state === "ARBITRATION"
      ? "pending"
      : m.state === "UPHELD"
        ? "upheld"
        : m.state === "WITHDRAWN"
          ? "withdrawn"
          : "rejected"; // UNPROVEN, MALICIOUS — and NONE, which cannot occur for a filed id

  const report: Report = {
    id: m.id,
    reporter: m.reporter,
    target: m.target,
    state,
    snapshotWeight: m.weightPoints,
  };

  if (state === "upheld") {
    if (m.resolvedAt === null) {
      throw new Error(
        `ReportRegistry report ${m.id} is UPHELD but its resolvedAt is 0. The engine needs that ` +
          `timestamp for §7.4 decay and the 180-day reporter-voiding window, and refuses to default it.`,
      );
    }
    report.upheldAt = m.resolvedAt;
  }

  // `queried` is meaningful only for a platform reporter (engine/src/score.ts's `platformQueryOk`
  // returns true for humans). Set it only in that case, so the field is never a claim about a
  // human reporter that nobody checked.
  if (platformIds.has(m.reporter.toLowerCase())) {
    report.queried = scoreRequestKeys.has(`${m.reporter.toLowerCase()}::${m.target.toLowerCase()}`);
  }

  return report;
}

// ─── caching, by block number (public RPCs rate-limit and lag) ───────────────────────────────────
// Two layers: the block number itself is cached briefly so a burst of requests within the same
// few seconds doesn't each pay for an `eth_blockNumber` round trip; the full graph computation
// (getLogs x4, paginated, plus ~3 reads per account) is cached per resolved block number, so two
// requests landing on the same block always return the identical, already-computed result.

const LATEST_BLOCK_TTL_MS = 4_000;
async function getLatestBlockCached(): Promise<bigint> {
  const nowMs = Date.now();
  if (state.latestBlock && nowMs - state.latestBlock.fetchedAt < LATEST_BLOCK_TTL_MS) {
    return state.latestBlock.block;
  }
  const block = await getClient().getBlockNumber();
  state.latestBlock = { fetchedAt: nowMs, block };
  return block;
}

// docs/07-app-api.md §5 asks for "cache.ts — 5s TTL, keyed by indexed block". World Chain mints a
// new block every second or two, so caching strictly by block number (recompute whenever the chain
// has moved at all) would recompute on nearly every request. A time window instead: two requests
// inside it see the identical, already-computed result, and a burst pays the RPC cost once. The
// result is still genuinely keyed by the block it was computed at — `meta.computedAtBlock` reports
// the real value, never a stale placeholder — and the incremental log accumulator above keeps a
// refresh cheap, re-scanning only the (usually empty) range since the last one.
//
// 15s rather than the doc's 5s: a single page load fans out to several API routes, and 5s is short
// enough that most of them miss. 15s is still well inside "live" for a trust score that changes on
// human timescales, and it is the difference between one upstream fetch per page and several.
const GRAPH_CACHE_TTL_MS = 15_000;
/** The live graph, cached for `GRAPH_CACHE_TTL_MS`. */
export async function getLiveGraph(): Promise<LiveGraph> {
  const nowMs = Date.now();
  if (state.graph && nowMs - state.graph.fetchedAt < GRAPH_CACHE_TTL_MS) return state.graph.promise;
  const latest = await getLatestBlockCached();
  const promise = fetchLiveGraph(latest);
  state.graph = { fetchedAt: nowMs, promise };
  // Don't let a failed fetch poison the cache for subsequent calls.
  promise.catch(() => {
    if (state.graph?.promise === promise) state.graph = null;
  });
  return promise;
}

export interface ChainHealth {
  chainId: number;
  currentBlock: bigint;
  deploymentBlock: bigint;
}

/** Cheap, no getLogs — just the RPC's current block vs. the deployment block. */
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

/** The canonical handle `address` enrolled with on `VouchMeRegistry` (e.g. "carol.vouchme.eth") — the
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
 *  config exists to avoid). Returned in wei (1e18 = 1 VOUCHME) so the caller controls rounding. */
export async function getAccruedDrip(address: Address): Promise<bigint> {
  const cfg = getConfig();
  return getClient().readContract({
    address: cfg.presenceDrip,
    abi: PRESENCE_ACCRUED_ABI,
    functionName: "accrued",
    args: [address],
  });
}

// ─── reporting-side live reads, for /api/report/attest ───────────────────────────────────────────
// Each of these mirrors a check `ReportRegistry.file()` will make anyway. Doing them before signing
// is not belt-and-braces: an attestation is single-use and consumed by the digest, so signing one
// that is guaranteed to revert burns it — and, worse, tells the person their report was accepted.

/** `keccak(abi.encode(a, b))` — the key ReportRegistry uses for `lastReportAt` and PlatformRegistry
 *  uses for `scoreRequests`. Both encode the pair the same way, so one helper serves both. */
function pairHash(a: Address, b: Address): Hex {
  return keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }], [a, b]));
}

export interface ReporterChainState {
  /** `ReportRegistry.voided[reporter]` — set by a MALICIOUS verdict. Every report from a voided
   *  reporter is refused on chain (`ReporterVoidedErr`). */
  voided: boolean;
  /** Open reports this account already has. Humans are capped at 1 (`HUMAN_CONCURRENT_CAP`). */
  openReportCount: number;
  /** Unix seconds of the reporter's last report against THIS target, 0 if never. The same pair is
   *  refused for `SAME_PAIR_COOLDOWN` (180 days) after it. */
  lastReportAt: number;
  /** True if the configured attestor key is actually allow-listed on the deployed ReportRegistry.
   *  A signature from a key the contract does not trust is refused (`BadAttestation`), and that is
   *  a deployment-wiring fact worth surfacing as its own error rather than as a failed transaction. */
  attestorEnabled: boolean;
}

export async function getReporterChainState(reporter: Address, target: Address, attestor: Address): Promise<ReporterChainState> {
  const cfg = getConfig();
  if (!cfg.reportRegistry) {
    throw new ChainConfigError("REPORT_REGISTRY_ADDRESS is not set; this deployment cannot file reports.");
  }
  const client = getClient();
  const registry = cfg.reportRegistry;
  const [voided, openReportCount, lastReportAt, attestorEnabled] = await Promise.all([
    client.readContract({ address: registry, abi: REPORT_REGISTRY_ABI, functionName: "voided", args: [reporter] }),
    client.readContract({ address: registry, abi: REPORT_REGISTRY_ABI, functionName: "openReportCount", args: [reporter] }),
    client.readContract({
      address: registry,
      abi: REPORT_REGISTRY_ABI,
      functionName: "lastReportAt",
      args: [pairHash(reporter, target)],
    }),
    client.readContract({ address: registry, abi: REPORT_REGISTRY_ABI, functionName: "attestors", args: [attestor] }),
  ]);
  return {
    voided,
    openReportCount: Number(openReportCount),
    lastReportAt: Number(lastReportAt),
    attestorEnabled,
  };
}

/** `PlatformRegistry.scoreRequests[keccak(platform, subject)]` — the precondition
 *  `ReportRegistry.file()` enforces with `NoScoreRequest()` for a platform reporter
 *  (contracts/src/ReportRegistry.sol:178). Read live: a ScoreRequest made seconds ago must count. */
export async function hasScoreRequest(platform: Address, subject: Address): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg.platformRegistry) return false;
  return getClient().readContract({
    address: cfg.platformRegistry,
    abi: PLATFORM_REGISTRY_ABI,
    functionName: "scoreRequests",
    args: [pairHash(platform, subject)],
  });
}

/** `PlatformRegistry.isRegistered(address)`, read live — which branch of `file()`'s eligibility
 *  test the caller will take is decided by this exact call inside the contract. */
export async function isRegisteredPlatform(address: Address): Promise<boolean> {
  const cfg = getConfig();
  if (!cfg.platformRegistry) return false;
  return getClient().readContract({
    address: cfg.platformRegistry,
    abi: PLATFORM_REGISTRY_ABI,
    functionName: "isRegistered",
    args: [address],
  });
}
