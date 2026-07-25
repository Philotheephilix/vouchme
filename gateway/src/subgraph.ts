// @aval/gateway — src/subgraph.ts
//
// Paginated GraphQL fetch of the whole Aval trust graph, using the exact
// query shape documented in docs/05-graph-data-layer.md §2.2 ("the one
// query the engine makes"). Returns data already shaped for @aval/engine's
// `compute(input)`.
//
// Caching: docs/04-ens.md §3.2 specifies a 5s gateway->Subgraph TTL, and
// docs/05-graph-data-layer.md §2.5 makes clear the graph is read at a
// specific indexed block (time-travel queries key on block number). We
// therefore cache **keyed by the indexed block number**, and each cache
// entry itself expires after GATEWAY_SUBGRAPH_TTL_MS (default 5000ms) so a
// demo still shows scores moving even when the indexer is between blocks.

export interface InboundEdge {
  voucherId: string; // address, lowercase hex
  expiresAt: bigint;
}

export type AccountStatus = "ACTIVE" | "GRACE" | "SUSPENDED" | "FRAUDULENT";

export interface SubgraphAccount {
  id: string; // address, lowercase hex
  isAnchor: boolean;
  status: AccountStatus;
  credentialExpiresAt: bigint;
  inbound: InboundEdge[]; // already filtered: revoked=false, expiresAt_gt=$now
}

export interface TrustGraphSnapshot {
  accounts: SubgraphAccount[];
  /** The indexed block this snapshot was read at — this is `aval.subgraph`'s companion,
   *  and what makes the score independently re-derivable (docs/04-ens.md §2.1). */
  blockNumber: bigint;
  /** IPFS deployment id of the Subgraph, e.g. "Qm...". Reported verbatim in every text record. */
  deploymentId: string;
  fetchedAt: number; // Date.now() in ms, for the TTL check
}

const TRUST_GRAPH_QUERY = /* GraphQL */ `
  query TrustGraph($first: Int!, $skip: Int!, $now: BigInt!) {
    accounts(first: $first, skip: $skip, where: { status_not: FRAUDULENT }) {
      id
      isAnchor
      status
      credentialExpiresAt
      inbound(where: { revoked: false, expiresAt_gt: $now }) {
        voucher { id }
        expiresAt
      }
    }
  }
`;

const META_QUERY = /* GraphQL */ `
  query Meta {
    _meta {
      block { number }
      deployment
    }
  }
`;

const PAGE_SIZE = 1000;

export interface SubgraphClientConfig {
  url: string;
  apiKey?: string | undefined;
  /** Fallback path when no API key is configured (docs/05 §4). */
  x402PrivateKey?: string | undefined;
  x402Chain?: string | undefined;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

async function postGraphQL<T>(
  config: SubgraphClientConfig,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  // NOTE: if neither apiKey nor x402PrivateKey is configured, the request is
  // attempted unauthenticated (fine for public Studio query URLs during dev).
  // The x402 handshake itself (402 -> pay -> retry) is the MCP server's job
  // (see mcp/src/client.ts); the gateway is expected to run with a funded
  // Graph API key in production, per docs/05 §6 build checklist.
  const res = await fetch(config.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`subgraph query failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as GraphQLResponse<T>;
  if (json.errors?.length) {
    throw new Error(`subgraph query errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!json.data) {
    throw new Error("subgraph query returned no data");
  }
  return json.data;
}

interface MetaResult {
  _meta: { block: { number: number }; deployment: string };
}

interface TrustGraphResult {
  accounts: {
    id: string;
    isAnchor: boolean;
    status: AccountStatus;
    credentialExpiresAt: string;
    inbound: { voucher: { id: string }; expiresAt: string }[];
  }[];
}

async function fetchIndexedBlock(config: SubgraphClientConfig): Promise<{ blockNumber: bigint; deploymentId: string }> {
  const data = await postGraphQL<MetaResult>(config, META_QUERY, {});
  return {
    blockNumber: BigInt(data._meta.block.number),
    deploymentId: data._meta.deployment,
  };
}

async function fetchAllAccounts(
  config: SubgraphClientConfig,
  blockNumber: bigint,
  now: bigint,
): Promise<SubgraphAccount[]> {
  const accounts: SubgraphAccount[] = [];
  let skip = 0;
  for (;;) {
    const data = await postGraphQL<TrustGraphResult>(config, TRUST_GRAPH_QUERY, {
      first: PAGE_SIZE,
      skip,
      now: now.toString(),
      // Pinning the block keeps every page of a single fetch internally
      // consistent even if the indexer advances mid-fetch.
      block: { number: Number(blockNumber) },
    });
    for (const a of data.accounts) {
      accounts.push({
        id: a.id.toLowerCase(),
        isAnchor: a.isAnchor,
        status: a.status,
        credentialExpiresAt: BigInt(a.credentialExpiresAt),
        inbound: a.inbound.map((e) => ({
          voucherId: e.voucher.id.toLowerCase(),
          expiresAt: BigInt(e.expiresAt),
        })),
      });
    }
    if (data.accounts.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }
  return accounts;
}

interface CacheEntry {
  snapshot: TrustGraphSnapshot;
  cachedAt: number;
}

/** Keyed by indexed block number (see module doc comment above). */
const cache = new Map<string, CacheEntry>();

export interface GetTrustGraphOptions {
  ttlMs?: number | undefined;
  now?: bigint | undefined;
}

/**
 * Fetches (or returns a cached copy of) the entire trust graph.
 * Cache key = indexed block number; cache entry TTL = 5s by default.
 */
export async function getTrustGraph(
  config: SubgraphClientConfig,
  options: GetTrustGraphOptions = {},
): Promise<TrustGraphSnapshot> {
  const ttlMs = options.ttlMs ?? 5000;
  const now = options.now ?? BigInt(Math.floor(Date.now() / 1000));

  const { blockNumber, deploymentId } = await fetchIndexedBlock(config);
  const key = blockNumber.toString();

  const hit = cache.get(key);
  if (hit && Date.now() - hit.cachedAt < ttlMs) {
    return hit.snapshot;
  }

  const accounts = await fetchAllAccounts(config, blockNumber, now);
  const snapshot: TrustGraphSnapshot = {
    accounts,
    blockNumber,
    deploymentId,
    fetchedAt: Date.now(),
  };
  cache.set(key, { snapshot, cachedAt: Date.now() });

  // Prune old block entries so the cache doesn't grow unbounded across a
  // long-running gateway process — only the current and previous block's
  // snapshots are worth keeping around.
  if (cache.size > 4) {
    const keys = [...cache.keys()].sort((a, b) => Number(BigInt(a) - BigInt(b)));
    for (const oldKey of keys.slice(0, keys.length - 4)) cache.delete(oldKey);
  }

  return snapshot;
}

export function clearTrustGraphCache(): void {
  cache.clear();
}

// ── naming graph: handle + issuedAt, for ENS name<->address resolution ──
//
// docs/05 §2.2's TRUST_GRAPH_QUERY above is deliberately the minimal shape
// the *scoring engine* needs. Deriving `carol.alice.aval.eth` as a string
// (and picking the canonical name among aliases — docs/04-ens.md §1.1,
// "shortest, then oldest, then lexicographic") additionally needs each
// account's immutable `handle` and each vouch's `issuedAt`, neither of
// which the engine query selects. This is a second, small query against
// the same Subgraph rather than a change to the engine's contract.

export interface NamingAccount {
  id: string;
  handle: string;
  isAnchor: boolean;
  /** "selfie-check" | "orb" | "document" — not selected by the engine query, needed for `aval.credential`. */
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

const NAMING_GRAPH_QUERY = /* GraphQL */ `
  query NamingGraph($first: Int!, $skip: Int!, $now: BigInt!) {
    accounts(first: $first, skip: $skip, where: { status_not: FRAUDULENT }) {
      id
      handle
      isAnchor
      credential
      outbound(where: { revoked: false, expiresAt_gt: $now }) {
        vouchee { id }
        issuedAt
        expiresAt
      }
    }
  }
`;

interface NamingGraphResult {
  accounts: {
    id: string;
    handle: string;
    isAnchor: boolean;
    credential: string;
    outbound: { vouchee: { id: string }; issuedAt: string; expiresAt: string }[];
  }[];
}

const namingCache = new Map<string, { snapshot: NamingSnapshot; cachedAt: number }>();

export async function getNamingGraph(
  config: SubgraphClientConfig,
  options: GetTrustGraphOptions = {},
): Promise<NamingSnapshot> {
  const ttlMs = options.ttlMs ?? 5000; // same 5s TTL as the trust graph (docs/04 §3.2)
  const now = options.now ?? BigInt(Math.floor(Date.now() / 1000));

  const { blockNumber, deploymentId } = await fetchIndexedBlock(config);
  const key = blockNumber.toString();
  const hit = namingCache.get(key);
  if (hit && Date.now() - hit.cachedAt < ttlMs) return hit.snapshot;

  const accounts: NamingAccount[] = [];
  const edges: NamingEdge[] = [];
  let skip = 0;
  for (;;) {
    const data = await postGraphQL<NamingGraphResult>(config, NAMING_GRAPH_QUERY, {
      first: PAGE_SIZE,
      skip,
      now: now.toString(),
      block: { number: Number(blockNumber) },
    });
    for (const a of data.accounts) {
      accounts.push({
        id: a.id.toLowerCase(),
        handle: a.handle,
        isAnchor: a.isAnchor,
        credential: a.credential,
      });
      for (const e of a.outbound) {
        edges.push({
          voucherId: a.id.toLowerCase(),
          voucheeId: e.vouchee.id.toLowerCase(),
          issuedAt: BigInt(e.issuedAt),
          expiresAt: BigInt(e.expiresAt),
        });
      }
    }
    if (data.accounts.length < PAGE_SIZE) break;
    skip += PAGE_SIZE;
  }

  const snapshot: NamingSnapshot = { accounts, edges, blockNumber, deploymentId };
  namingCache.set(key, { snapshot, cachedAt: Date.now() });
  if (namingCache.size > 4) {
    const keys = [...namingCache.keys()].sort((a, b) => Number(BigInt(a) - BigInt(b)));
    for (const oldKey of keys.slice(0, keys.length - 4)) namingCache.delete(oldKey);
  }
  return snapshot;
}
