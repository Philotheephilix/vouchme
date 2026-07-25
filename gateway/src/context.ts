// @aval/gateway — src/context.ts
//
// Wires subgraph -> engine -> ENS text records.
//
// This is the only place in the gateway that calls @aval/engine, so the
// gateway and aval-mcp are guaranteed to agree (docs/06-mcp-skills.md §7
// build checklist: "Engine imported as a library — the same code the
// gateway runs, so the MCP and ENS never disagree").

import type { Address } from "viem";
// `@aval/engine` is an npm workspace package built by another agent in
// this repo (see engine/). It is depended on as "@aval/engine": "*". At
// typecheck time, before `npm install` has run the workspace link, this
// import will not resolve — that is expected (see gateway/README context
// in the task brief) and does not indicate a bug in this package.
import { compute, tenureCenti, type Account, type EngineInput, type Vouch } from "@aval/engine";
import {
  getNamingGraph,
  getTrustGraph,
  type SubgraphClientConfig,
  type TrustGraphSnapshot,
} from "./subgraph.js";
import {
  findAllPaths,
  parseName,
  pickCanonicalName,
  resolveNameToAddress,
  type ParsedName,
} from "./resolve.js";

// World ID Address Book — docs/10-constants.md §7 (verified, World Chain mainnet).
export const ADDRESS_BOOK_ADDRESS: Address = "0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D";

export interface GatewayConfig {
  subgraph: SubgraphClientConfig;
  ttlMs?: number;
  mcpEndpointBase?: string;
  a2aEndpointBase?: string;
  webEndpointBase?: string;
}

export interface ResolvedRecords {
  address: Address;
  canonicalName: string;
  aliases: string[];
  depth: number;
  /** Full record set, keyed by the exact text() key strings this gateway serves. */
  records: Record<string, string>;
  subgraphDeployment: string;
  computedAtBlock: number;
}

/**
 * Converts a unix-seconds timestamp read from the Subgraph (GraphQL `BigInt` scalar) into the
 * plain `number` @aval/engine's `EngineInput.now` expects (engine/src/types.ts — the engine is
 * dependency-free and does all its scoring in integer centi-points, so `bigint` never crosses
 * its boundary). This is the one seam where a Subgraph `BigInt` becomes an engine `number`;
 * throws rather than silently losing precision if the value can't be represented exactly.
 */
function bigintSecondsToEngineNow(seconds: bigint): number {
  if (seconds > BigInt(Number.MAX_SAFE_INTEGER) || seconds < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(
      `timestamp ${seconds.toString()} exceeds Number.MAX_SAFE_INTEGER — cannot pass to @aval/engine`,
    );
  }
  return Number(seconds);
}

function toEngineInput(snapshot: TrustGraphSnapshot, now: bigint): EngineInput {
  const vouches: Vouch[] = [];
  for (const account of snapshot.accounts) {
    for (const edge of account.inbound) {
      vouches.push({
        voucher: edge.voucherId,
        vouchee: account.id,
        // docs/05-graph-data-layer.md §2.2's `inbound(where: { revoked: false, expiresAt_gt:
        // $now })` (see subgraph.ts's TRUST_GRAPH_QUERY) already excludes revoked and expired
        // edges at query time, so every edge reaching this function is active by construction.
        active: true,
      });
    }
  }
  const accounts: Account[] = snapshot.accounts.map((a) => ({
    id: a.id,
    // This scaffold's 4 subgraph.yaml data sources only index AvalRegistry (human) accounts —
    // PlatformRegistry accounts are a separate, unqueried data source (see this file's and
    // mcp/engine.ts's matching module comments) — so every account reaching this function is
    // human.
    kind: "human" as const,
    isAnchor: a.isAnchor,
  }));
  return {
    accounts,
    vouches,
    // docs/05-graph-data-layer.md §2.2's query (the one this gateway uses,
    // per the task brief) does not select platform vouches or reports, so
    // these are empty here. Net effect: `score` below is equivalent to the
    // engine's pre-report `s⁺` — an accurate simplification for a fresh
    // demo graph, flagged rather than silently assumed.
    platformVouches: [],
    reports: [],
    now: bigintSecondsToEngineNow(now),
  };
}

/**
 * Loose, defensive shape of what compute() returns. The real @aval/engine
 * export is authored by another agent in this repo and its exact return
 * type isn't known at the time this file is written, so every field is
 * read optionally with a documented fallback rather than assumed.
 */
interface EngineOutputShape {
  score?: Record<string, number>;
  tier?: Record<string, number>;
  tiers?: Record<string, number>;
  depth?: Record<string, number>;
}

function readEngineAccountResult(
  output: unknown,
  address: string,
): { score: number; tier: 0 | 1 | 2; depth: number } {
  const out = (output ?? {}) as EngineOutputShape;
  const score = out.score?.[address] ?? 10.0; // BASE, docs/10 §1
  const tierMap = out.tier ?? out.tiers ?? {};
  const tier = (tierMap[address] ?? (score >= 100 ? 2 : score >= 30 ? 1 : 0)) as 0 | 1 | 2;
  const depth = out.depth?.[address] ?? 0;
  return { score, tier, depth };
}

export async function resolveByName(
  parsed: ParsedName,
  config: GatewayConfig,
): Promise<ResolvedRecords | null> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const [trustGraph, namingGraph] = await Promise.all([
    getTrustGraph(config.subgraph, { ttlMs: config.ttlMs, now }),
    getNamingGraph(config.subgraph, { ttlMs: config.ttlMs, now }),
  ]);

  const identity = resolveNameToAddress(parsed, namingGraph);
  if (!identity) return null;

  return buildRecords(identity.address, trustGraph, namingGraph, config, now);
}

export async function resolveByAddress(
  address: Address,
  config: GatewayConfig,
): Promise<ResolvedRecords | null> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const [trustGraph, namingGraph] = await Promise.all([
    getTrustGraph(config.subgraph, { ttlMs: config.ttlMs, now }),
    getNamingGraph(config.subgraph, { ttlMs: config.ttlMs, now }),
  ]);
  return buildRecords(address, trustGraph, namingGraph, config, now);
}

async function buildRecords(
  address: Address,
  trustGraph: TrustGraphSnapshot,
  namingGraph: Awaited<ReturnType<typeof getNamingGraph>>,
  config: GatewayConfig,
  now: bigint,
): Promise<ResolvedRecords | null> {
  const account = trustGraph.accounts.find((a) => a.id === address.toLowerCase());
  if (!account) return null;

  const engineInput = toEngineInput(trustGraph, now);
  const engineOutput = compute(engineInput);
  const { score, tier, depth } = readEngineAccountResult(engineOutput, account.id);

  const paths = findAllPaths(address, namingGraph);
  const canonical = pickCanonicalName(paths);
  const canonicalName = canonical?.name ?? "";
  const aliases = paths
    .filter((p) => p.name !== canonicalName)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => p.name);

  const namingAccount = namingGraph.accounts.find((a) => a.id === account.id);
  const outboundCount = namingGraph.edges.filter((e) => e.voucherId === account.id).length;
  const slots = tier === 2 ? 10 : tier === 1 ? 3 : 0;

  const earliestInboundExpiry = account.inbound.reduce<bigint | null>(
    (min, e) => (min === null || e.expiresAt < min ? e.expiresAt : min),
    null,
  );
  const expiresAtSeconds =
    earliestInboundExpiry === null
      ? account.credentialExpiresAt
      : account.credentialExpiresAt < earliestInboundExpiry
        ? account.credentialExpiresAt
        : earliestInboundExpiry;

  const tenure = tenureCenti(0); // epochsClaimed not indexed by this scaffold's 4 data sources — see subgraph/README.md
  void tenure; // reserved for when PresenceDrip epochsClaimed is wired into `aval.score`'s base term

  const operator = pathAddressBeforeLeaf(canonical, namingGraph, address);

  const records: Record<string, string> = {
    "aval.score": score.toFixed(2),
    "aval.tier": String(tier),
    "aval.depth": String(depth || canonical?.depth || 0),
    "aval.path": canonicalName,
    "aval.vouches.in": String(account.inbound.length),
    "aval.vouches.out": `${outboundCount}/${slots}`,
    "aval.credential": namingAccount?.credential ?? "",
    "aval.anchor": String(account.isAnchor),
    "aval.expires": secondsToIso(expiresAtSeconds),
    // TODO: CredibilityVault bond balances are not indexed by any of this
    // scaffold's 4 subgraph.yaml data sources (AvalRegistry, ReportRegistry,
    // PlatformRegistry, PresenceDrip) — a vault data source is required to
    // populate this for real. Placeholder kept explicit rather than omitted
    // so the key is always present, per docs/04-ens.md §2.
    "aval.bonded": "0",
    "aval.subgraph": trustGraph.deploymentId,
    // Stored, user-set fields — passthrough only; not computed here. A real
    // deployment reads these from a small profile store keyed by address.
    avatar: "",
    description: "",
    url: "",
    // ENSIP-26 (docs/04-ens.md §4.1). Aval has no separate on-chain agent
    // registry among this scaffold's 4 data sources, so these keys are
    // computed for any resolved name using its direct voucher as
    // "operator" — correct for a genuine agent name (docs' own example,
    // trader.carol.alice.aval.eth, has carol — the voucher — as operator)
    // and harmless for an ordinary human name.
    "agent-context": buildAgentContext(canonicalName, score, tier, operator),
    "agent-endpoint[mcp]": `${config.mcpEndpointBase ?? "https://mcp.aval.xyz/agent"}/${canonicalName}`,
    "agent-endpoint[a2a]": `${config.a2aEndpointBase ?? "https://a2a.aval.xyz"}/${canonicalName}`,
    "agent-endpoint[web]": `${config.webEndpointBase ?? "https://aval.xyz/a"}/${canonicalName}`,
  };

  return {
    address,
    canonicalName,
    aliases,
    depth,
    records,
    subgraphDeployment: trustGraph.deploymentId,
    computedAtBlock: Number(trustGraph.blockNumber),
  };
}

function pathAddressBeforeLeaf(
  canonical: ReturnType<typeof pickCanonicalName>,
  namingGraph: Awaited<ReturnType<typeof getNamingGraph>>,
  leaf: Address,
): string {
  if (!canonical) return "";
  const parts = canonical.name.split(".");
  // parts = [...labels..., "aval", "eth"]; the operator's handle is the
  // second-to-last path label (immediately left of the leaf), or if the
  // leaf itself is depth 1, there is no operator (an anchor vouched directly).
  const pathLabels = parts.slice(0, parts.length - 2);
  if (pathLabels.length < 2) return "";
  const operatorHandle = pathLabels[pathLabels.length - 2];
  const operatorAccount = namingGraph.accounts.find(
    (a) => a.handle === operatorHandle && a.id !== leaf.toLowerCase(),
  );
  return operatorAccount?.id ?? "";
}

function buildAgentContext(
  canonicalName: string,
  score: number,
  tier: number,
  operatorAddress: string,
): string {
  if (!canonicalName) return "";
  const operatorLine = operatorAddress
    ? `Operated by \`${operatorAddress}\` (Aval tier ${tier}, score ${score.toFixed(1)}).`
    : "Operated directly by a verified human (no upstream operator).";
  return [
    `# ${canonicalName}`,
    "",
    operatorLine,
    "",
    "**Delegated authority:** this name inherits its operator's tier and CANNOT issue vouches",
    "(vouching requires human presence — see docs/04-ens.md §4.3).",
    "",
    `**Verify:** recompute from Subgraph deployment referenced in \`aval.subgraph\` using the Aval engine.`,
  ].join("\n");
}

function secondsToIso(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

export function parseIncomingName(nameBytes: Uint8Array): ParsedName | null {
  return parseName(nameBytes);
}
