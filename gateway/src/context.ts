// @aval/gateway — src/context.ts
//
// Wires live chain data -> engine -> ENS text records.
//
// This is the only place in the gateway that calls @aval/engine, so the
// gateway and aval-mcp are guaranteed to agree (docs/06-mcp-skills.md §7
// build checklist: "Engine imported as a library — the same code the
// gateway runs, so the MCP and ENS never disagree").
//
// There is no deployed Aval Subgraph (deployments/worldchain-sepolia.json's own notes) —
// `getTrustGraph`/`getNamingGraph` below read World Chain Sepolia directly (src/chain.ts) instead
// of querying one, so every text record this module computes traces back to real chain events and
// a real `compute()` call.

import type { Address } from "viem";
import {
  compute,
  tenureCenti,
  BASE as BASE_CENTI,
  SLOTS_TIER_0,
  SLOTS_TIER_1,
  SLOTS_TIER_2,
  type Account,
  type EngineInput,
  type EngineOutput,
  type Vouch,
} from "@aval/engine";

/** Display-point (÷100) mirror of @aval/engine's own BASE — never a second, independently-
 *  hardcoded fallback number, so a change to docs/10-constants.md's BASE follows automatically. */
const BASE_DISPLAY = BASE_CENTI / 100;

function slotsFor(tier: 0 | 1 | 2): number {
  return tier === 2 ? SLOTS_TIER_2 : tier === 1 ? SLOTS_TIER_1 : SLOTS_TIER_0;
}
import {
  getAnchorBookAddress,
  getNamingGraph,
  getTrustGraph,
  type ChainClientConfig,
  type TrustGraphSnapshot,
} from "./chain.js";
import {
  bareLabel,
  findAllPaths,
  parseName,
  pickCanonicalName,
  resolveNameToAddress,
  type ParsedName,
} from "./resolve.js";

/** GenesisAnchorBook — this deployment's testnet stand-in for World ID's Address Book, which does
 *  not exist on World Chain Sepolia (deployments/worldchain-sepolia.json). Read from the
 *  deployment record, never hardcoded; the real mainnet Address Book address
 *  (0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D) would be actively wrong here. */
export function getAnchorBookAddressForHealth(): Address {
  return getAnchorBookAddress();
}

export interface GatewayConfig {
  chain: ChainClientConfig;
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
        // chain.ts's live read already excludes revoked and expired edges at fetch time
        // (docs/01-trust-math.md §14, §18: expiry is a query-time predicate, evaluated against
        // the read block's own timestamp) and resolves any duplicate Vouched/Reaffirmed/Revoked
        // records for the same pair to exactly one edge before this function ever sees it, so
        // every edge reaching this function is active by construction.
        active: true,
      });
    }
  }
  const accounts: Account[] = snapshot.accounts.map((a) => ({
    id: a.id,
    // chain.ts reads only AvalRegistry (human) accounts — PlatformRegistry accounts are a
    // separate contract this gateway does not read (see this file's and mcp/engine.ts's matching
    // module comments) — so every account reaching this function is human.
    kind: "human" as const,
    isAnchor: a.isAnchor,
  }));
  return {
    accounts,
    vouches,
    // chain.ts's live read does not include platform vouches or reports (ReportRegistry /
    // PlatformRegistry are separate contracts this gateway does not read), so these are empty
    // here. Net effect: `score` below is equivalent to the engine's pre-report `s⁺` — an accurate
    // simplification for this deployment's graph (no reports exist), flagged rather than silently
    // assumed.
    platformVouches: [],
    reports: [],
    now: bigintSecondsToEngineNow(now),
  };
}

/**
 * The authoritative score/tier/depth for one address, straight off @aval/engine's own
 * `compute()` output — never reimplemented. `output.score` is integer centi-points
 * (score × 100, engine/src/types.ts); `/ 100` here is the one place that unit crosses into the
 * decimal points every `aval.score` text record and docs/04-ens.md's own example ("62.5") use.
 * `depth` may be `Infinity` for an address with no active path to any origin — callers render
 * that case explicitly rather than let it silently stringify as "Infinity".
 */
function readEngineAccountResult(output: EngineOutput, address: string): { score: number; tier: 0 | 1 | 2; depth: number } {
  const scoreCenti = output.score[address];
  if (scoreCenti === undefined) {
    // Not present in this computation — shouldn't happen, since `address` was already confirmed
    // to be in trustGraph.accounts, which is exactly what built engineInput.accounts. BASE_DISPLAY
    // (derived from @aval/engine's own BASE, docs/10-constants.md §1) rather than a hardcoded
    // literal, so this fallback tracks a constants change automatically.
    return { score: BASE_DISPLAY, tier: 0, depth: 0 };
  }
  return {
    score: scoreCenti / 100,
    tier: output.tier[address] ?? 0,
    depth: output.depth[address] ?? Number.POSITIVE_INFINITY,
  };
}

export async function resolveByName(
  parsed: ParsedName,
  config: GatewayConfig,
): Promise<ResolvedRecords | null> {
  const now = BigInt(Math.floor(Date.now() / 1000));
  const [trustGraph, namingGraph] = await Promise.all([
    getTrustGraph(config.chain, { ttlMs: config.ttlMs, now }),
    getNamingGraph(config.chain, { ttlMs: config.ttlMs, now }),
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
    getTrustGraph(config.chain, { ttlMs: config.ttlMs, now }),
    getNamingGraph(config.chain, { ttlMs: config.ttlMs, now }),
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
  // Multiple anchors can each independently reach the same intermediate handle, producing
  // distinct path objects that render to the identical name string — dedupe by name, not by path
  // object.
  const aliases = [...new Set(paths.filter((p) => p.name !== canonicalName).map((p) => p.name))].sort((a, b) =>
    a.localeCompare(b),
  );

  const namingAccount = namingGraph.accounts.find((a) => a.id === account.id);
  const outboundCount = namingGraph.edges.filter((e) => e.voucherId === account.id).length;
  const slots = slotsFor(tier);

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
    // Depth 0 means "origin" (an anchor, or a promoted Tier-2 account) in this protocol — the MOST
    // trusted position in the graph — so an unreachable account must never fall back to 0, which
    // would render a ring member indistinguishable from an anchor. "unreachable" matches
    // @aval/mcp's depthForJson() convention.
    "aval.depth": Number.isFinite(depth) ? String(depth) : "unreachable",
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
    (a) => bareLabel(a.handle) === operatorHandle && a.id !== leaf.toLowerCase(),
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
    `**Verify:** recompute from the source referenced in \`aval.subgraph\` (World Chain Sepolia, ` +
      `read directly — no subgraph deployed) using the Aval engine.`,
  ].join("\n");
}

function secondsToIso(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

export function parseIncomingName(nameBytes: Uint8Array): ParsedName | null {
  return parseName(nameBytes);
}
