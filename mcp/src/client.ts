// @aval/mcp — src/client.ts
//
// Data access for the Aval Subgraph, with two paths (docs/05-graph-data-layer.md §4):
//
//   1. A funded Graph Gateway API key (GRAPH_API_KEY) — the normal path.
//   2. x402: per-query USDC on Base, no account, no key (X402_PRIVATE_KEY).
//      "anybody can run our MCP server with nothing but a funded key."
//
// docs/06-mcp-skills.md §6's reusability test is explicit: `npx -y @aval/mcp`
// with ONLY X402_PRIVATE_KEY set must work. This module is what makes that
// true — GraphClient always exposes the same `query`/`meta` surface
// regardless of which path is active, and every tool in src/tools/*.ts is
// written against that interface, never against fetch() directly.

export interface GraphClientConfig {
  subgraphId: string;
  /** Overrides the derived Gateway URL — useful for Subgraph Studio / local Graph Node during dev. */
  subgraphUrl?: string | undefined;
  graphApiKey?: string | undefined;
  x402PrivateKey?: string | undefined;
  x402Chain?: string | undefined;
}

export interface SubgraphMeta {
  deploymentId: string;
  blockNumber: number;
}

export interface GraphQLResult<T> {
  data: T;
  meta: SubgraphMeta;
}

export interface GraphClient {
  query<T>(query: string, variables?: Record<string, unknown>): Promise<GraphQLResult<T>>;
  meta(): Promise<SubgraphMeta>;
}

export class GraphClientConfigError extends Error {}

// ── x402 payment handshake — stubbed behind a clear interface ───────────
//
// docs/05 §4:
//   POST https://gateway.thegraph.com/api/x402/subgraphs/id/{subgraph_id}
//     -> 402 Payment Required + payment details
//     -> client signs a USDC payment (Base), retries with the payment header
//     -> gateway verifies via the facilitator, returns the result
//
// The actual signing step needs an EIP-3009 (or x402's chosen scheme)
// transferWithAuthorization signature over USDC on Base, produced from
// X402_PRIVATE_KEY. That belongs behind this interface, not inlined into
// fetch() calls — it is what `@graphprotocol/client-x402` implements, and
// swapping this stub for a real implementation (or for that package) should
// not require touching any tool file.
export interface X402PaymentHandler {
  /**
   * Given the original request and the 402 response describing what's
   * owed, returns headers to attach to a retried request that satisfies
   * payment. Throws X402NotImplementedError until wired to a real signer.
   */
  authorize(request: { url: string; init: RequestInit }, paymentDetails: unknown): Promise<Record<string, string>>;
}

export class X402NotImplementedError extends Error {
  constructor() {
    super(
      "x402 payment handshake is not implemented in this scaffold. " +
        "Wire X402PaymentHandler.authorize() to sign a USDC-on-Base payment " +
        "(EIP-3009 transferWithAuthorization) from X402_PRIVATE_KEY — see " +
        "docs/05-graph-data-layer.md §4, or depend on @graphprotocol/client-x402.",
    );
  }
}

export function createStubX402Handler(_privateKey: string, _chain: string): X402PaymentHandler {
  return {
    async authorize() {
      throw new X402NotImplementedError();
    },
  };
}

// ── GraphQL transport shared by both paths ───────────────────────────────

interface GraphQLEnvelope<T> {
  data?: T;
  errors?: { message: string }[];
}

async function postGraphQL<T>(url: string, headers: Record<string, string>, query: string, variables: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`subgraph query failed: ${res.status} ${res.statusText}`);
  }
  const json = (await res.json()) as GraphQLEnvelope<T>;
  if (json.errors?.length) {
    throw new Error(`subgraph query errors: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (json.data === undefined) throw new Error("subgraph query returned no data");
  return json.data;
}

const META_QUERY = /* GraphQL */ `
  query Meta {
    _meta { block { number } deployment }
  }
`;

interface MetaResult {
  _meta: { block: { number: number }; deployment: string };
}

class ApiKeyGraphClient implements GraphClient {
  constructor(private readonly url: string, private readonly apiKey: string) {}

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<GraphQLResult<T>> {
    const [data, meta] = await Promise.all([
      postGraphQL<T>(this.url, { authorization: `Bearer ${this.apiKey}` }, query, variables),
      this.meta(),
    ]);
    return { data, meta };
  }

  async meta(): Promise<SubgraphMeta> {
    const result = await postGraphQL<MetaResult>(this.url, { authorization: `Bearer ${this.apiKey}` }, META_QUERY, {});
    return { deploymentId: result._meta.deployment, blockNumber: result._meta.block.number };
  }
}

class X402GraphClient implements GraphClient {
  constructor(
    private readonly url: string,
    private readonly handler: X402PaymentHandler,
  ) {}

  private async request<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    };
    const first = await fetch(this.url, init);
    if (first.status !== 402) {
      if (!first.ok) throw new Error(`x402 subgraph query failed: ${first.status} ${first.statusText}`);
      const json = (await first.json()) as GraphQLEnvelope<T>;
      if (json.data === undefined) throw new Error("x402 subgraph query returned no data");
      return json.data;
    }
    const paymentDetails: unknown = await first.json();
    const paymentHeaders = await this.handler.authorize({ url: this.url, init }, paymentDetails);
    const retry = await fetch(this.url, { ...init, headers: { ...(init.headers as Record<string, string>), ...paymentHeaders } });
    if (!retry.ok) throw new Error(`x402 subgraph query failed after payment: ${retry.status} ${retry.statusText}`);
    const json = (await retry.json()) as GraphQLEnvelope<T>;
    if (json.data === undefined) throw new Error("x402 subgraph query returned no data after payment");
    return json.data;
  }

  async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<GraphQLResult<T>> {
    const [data, meta] = await Promise.all([this.request<T>(query, variables), this.meta()]);
    return { data, meta };
  }

  async meta(): Promise<SubgraphMeta> {
    const result = await this.request<MetaResult>(META_QUERY, {});
    return { deploymentId: result._meta.deployment, blockNumber: result._meta.block.number };
  }
}

/**
 * Picks the API-key path when GRAPH_API_KEY is set, otherwise falls back
 * to x402 (docs/05 §4, "Downstream: aval-mcp reads its own Subgraph
 * through x402 when no gateway API key is configured").
 */
export function createGraphClient(config: GraphClientConfig): GraphClient {
  const url = config.subgraphUrl ?? `https://gateway.thegraph.com/api/subgraphs/id/${config.subgraphId}`;

  if (config.graphApiKey) {
    return new ApiKeyGraphClient(url, config.graphApiKey);
  }

  if (config.x402PrivateKey) {
    const x402Url = `https://gateway.thegraph.com/api/x402/subgraphs/id/${config.subgraphId}`;
    const handler = createStubX402Handler(config.x402PrivateKey, config.x402Chain ?? "base");
    return new X402GraphClient(x402Url, handler);
  }

  throw new GraphClientConfigError(
    "Neither GRAPH_API_KEY nor X402_PRIVATE_KEY is set. aval-mcp needs one of the two (see mcp/README.md).",
  );
}

export function loadGraphClientConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GraphClientConfig {
  const subgraphId = env.AVAL_SUBGRAPH_ID;
  if (!subgraphId) {
    throw new GraphClientConfigError("AVAL_SUBGRAPH_ID is not set (see mcp/README.md).");
  }
  return {
    subgraphId,
    subgraphUrl: env.AVAL_SUBGRAPH_URL,
    graphApiKey: env.GRAPH_API_KEY,
    x402PrivateKey: env.X402_PRIVATE_KEY,
    x402Chain: env.X402_CHAIN,
  };
}

/**
 * `createGraphClient(loadGraphClientConfigFromEnv(env))`, except construction never throws.
 *
 * No Aval Subgraph is deployed for this task (deployments/worldchain-sepolia.json's own notes) —
 * the 8 tools that must work regardless (docs/06 §2.1-§2.7, §2.9) get their data from
 * src/chain.ts's live World Chain Sepolia reads and never touch this client at all. But
 * `loadToolContext()` (index.ts) used to build a `GraphClient` unconditionally at server startup,
 * which meant a missing `AVAL_SUBGRAPH_ID` failed the ENTIRE server, including the tools that
 * don't need it. This constructs the client lazily instead: if subgraph config is genuinely
 * absent, every tool that still depends on it (aval_report / aval_report_status / aval_platform /
 * aval_request_score / aval_query / aval_cross_protocol_trust's Aval leg's ReportRegistry /
 * PlatformRegistry reads) gets the same named `GraphClientConfigError` the moment it actually
 * tries to query — refusing with a named error rather than fabricating data, per the task brief —
 * instead of the whole process refusing to start.
 */
export function createGraphClientSafe(env: NodeJS.ProcessEnv = process.env): GraphClient {
  try {
    return createGraphClient(loadGraphClientConfigFromEnv(env));
  } catch (err) {
    if (err instanceof GraphClientConfigError) {
      return {
        query() {
          return Promise.reject(err);
        },
        meta() {
          return Promise.reject(err);
        },
      };
    }
    throw err;
  }
}
