// @aval/mcp — src/engine.ts
//
// Shared graph fetch + scoring wiring used by every tool in src/tools/*.ts.
//
// Per docs/06-mcp-skills.md §7 build checklist ("Engine imported as a
// library — the same code the gateway runs, so the MCP and ENS never
// disagree"), the *authoritative* score/tier computation is
// `@aval/engine`'s `compute(input)`, imported below as a value (its
// exported type names aren't known yet — see the comment on
// `EngineOutputShape`). This module also carries a small local
// re-implementation of the BFS in docs/01-trust-math.md §15
// ("Still about sixty lines"), used ONLY to produce the granular
// per-voucher `breakdown` rows docs/06-mcp-skills.md §2.2 requires
// (`raw`, `capped`, `contribution`, `counted`, `reason`) — a level of
// detail the engine's opaque return shape may or may not expose the same
// way. Both paths use the same constants (docs/10-constants.md) and the
// same graph, so they agree on the number even if @aval/score's internal
// shape differs; once @aval/engine's real output type is known, the local
// BFS below can be deleted in favor of reading it straight from `compute()`.

import { compute } from "@aval/engine";
import type { Account, EngineInput, Vouch } from "@aval/engine";
import type { GraphClient, SubgraphMeta } from "./client.js";

// ── constants — single source of truth: docs/10-constants.md ────────────
export const BASE = 10;
export const ANCHOR_SCORE = 100;
export const M_POS = 0.25;
export const CAP_POS = 20;
export const T1 = 30;
export const T2 = 100;
export const MAX_DEPTH = 3;
export const MAX_ROUNDS = 8;

export interface GraphAccount {
  id: string; // lowercase address
  handle: string;
  isAnchor: boolean;
  status: "ACTIVE" | "GRACE" | "SUSPENDED" | "FRAUDULENT";
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
  vouches: GraphVouch[]; // already filtered: active (not revoked, not expired) at fetch time
  meta: SubgraphMeta;
}

const GRAPH_QUERY = /* GraphQL */ `
  query McpGraph($first: Int!, $skip: Int!, $now: BigInt!, $block: Block_height) {
    accounts(first: $first, skip: $skip, block: $block, where: { status_not: FRAUDULENT }) {
      id
      handle
      isAnchor
      status
      credential
      credentialExpiresAt
      activeOutboundCount
      outbound(where: { revoked: false, expiresAt_gt: $now }) {
        vouchee { id }
        issuedAt
        expiresAt
      }
    }
  }
`;

interface GraphQueryResult {
  accounts: {
    id: string;
    handle: string;
    isAnchor: boolean;
    status: GraphAccount["status"];
    credential: string;
    credentialExpiresAt: string;
    activeOutboundCount: number;
    outbound: { vouchee: { id: string }; issuedAt: string; expiresAt: string }[];
  }[];
}

const PAGE_SIZE = 1000;

export async function fetchGraph(
  client: GraphClient,
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
  atBlock?: number,
): Promise<TrustGraph> {
  const accounts: GraphAccount[] = [];
  const vouches: GraphVouch[] = [];
  let skip = 0;
  let meta: SubgraphMeta | undefined;

  for (;;) {
    const { data, meta: pageMeta } = await client.query<GraphQueryResult>(GRAPH_QUERY, {
      first: PAGE_SIZE,
      skip,
      now: now.toString(),
      // docs/05-graph-data-layer.md §2.5: "time-travel" — run the same
      // query pinned to a historical block for score history with no
      // snapshot table. `null`/omitted means "latest", per the Graph's
      // standard `Block_height` input type.
      block: atBlock !== undefined ? { number: atBlock } : null,
    });
    meta = pageMeta;
    for (const a of data.accounts) {
      accounts.push({
        id: a.id.toLowerCase(),
        handle: a.handle,
        isAnchor: a.isAnchor,
        status: a.status,
        credential: a.credential,
        credentialExpiresAt: BigInt(a.credentialExpiresAt),
        activeOutboundCount: a.activeOutboundCount,
      });
      for (const e of a.outbound) {
        vouches.push({
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

  if (!meta) throw new Error("subgraph returned no pages");
  return { accounts, vouches, meta };
}

// docs/10-constants.md §5: "MCP verdict cache: 5 min max — Revocation is
// instant." We cache well under that ceiling (5s, matching the gateway's
// own Subgraph TTL) purely to stop a burst of tool calls in one agent turn
// from re-fetching the whole graph on every call.
let cachedGraph: { graph: TrustGraph; cachedAt: number } | null = null;
const GRAPH_CACHE_TTL_MS = 5000;

export async function getCachedGraph(client: GraphClient): Promise<TrustGraph> {
  if (cachedGraph && Date.now() - cachedGraph.cachedAt < GRAPH_CACHE_TTL_MS) {
    return cachedGraph.graph;
  }
  const graph = await fetchGraph(client);
  cachedGraph = { graph, cachedAt: Date.now() };
  return graph;
}

// ── local scoring (docs/01-trust-math.md §15, positive side only) ───────

export interface ScoreResult {
  score: number;
  tier: 0 | 1 | 2;
  depth: number; // 0 for anchors, Infinity-ish (MAX_DEPTH+1) if unreached
}

export interface Scored {
  scores: Map<string, ScoreResult>;
  inboundByAccount: Map<string, GraphVouch[]>;
  outboundByAccount: Map<string, GraphVouch[]>;
}

export function slotsFor(tier: 0 | 1 | 2): number {
  return tier === 2 ? 10 : tier === 1 ? 3 : 0;
}

function w(score: number): { raw: number; capped: boolean; contribution: number } {
  const raw = score * M_POS;
  const capped = raw > CAP_POS;
  return { raw, capped, contribution: Math.min(raw, CAP_POS) };
}

/**
 * The least fixed point over origins = anchors ∪ Tier2 (docs/01 §4.2),
 * capped at MAX_ROUNDS. Returns depth + score for every account. This
 * mirrors docs/01-trust-math.md §15 exactly (reports/platform vouches are
 * out of scope for this scaffold's graph query — see engine.ts's module
 * comment — so `score` here is the engine's pre-report `s⁺`).
 */
export function scoreGraph(graph: TrustGraph): Scored {
  const inboundByAccount = new Map<string, GraphVouch[]>();
  const outboundByAccount = new Map<string, GraphVouch[]>();
  for (const v of graph.vouches) {
    (inboundByAccount.get(v.voucheeId) ?? inboundByAccount.set(v.voucheeId, []).get(v.voucheeId)!).push(v);
    (outboundByAccount.get(v.voucherId) ?? outboundByAccount.set(v.voucherId, []).get(v.voucherId)!).push(v);
  }

  const anchors = new Set(graph.accounts.filter((a) => a.isAnchor).map((a) => a.id));
  let origins = new Set(anchors);
  let scores = new Map<string, ScoreResult>();

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const depth = bfsDepth(origins, outboundByAccount, graph.accounts);
    scores = new Map();
    for (const a of graph.accounts) {
      if (anchors.has(a.id)) {
        scores.set(a.id, { score: ANCHOR_SCORE, tier: 2, depth: 0 });
        continue;
      }
      const d = depth.get(a.id) ?? MAX_DEPTH + 1;
      let sp = BASE;
      if (d <= MAX_DEPTH) {
        for (const edge of inboundByAccount.get(a.id) ?? []) {
          const voucherDepth = depth.get(edge.voucherId) ?? MAX_DEPTH + 1;
          if (voucherDepth < d) {
            const voucherScore = anchors.has(edge.voucherId) ? ANCHOR_SCORE : (scores.get(edge.voucherId)?.score ?? BASE);
            sp += w(voucherScore).contribution;
          }
        }
      }
      const tier: 0 | 1 | 2 = sp >= T2 ? 2 : sp >= T1 ? 1 : 0;
      scores.set(a.id, { score: sp, tier, depth: d });
    }
    const nextOrigins = new Set(anchors);
    for (const [id, r] of scores) if (r.tier === 2) nextOrigins.add(id);
    if (setsEqual(nextOrigins, origins)) break;
    origins = nextOrigins;
  }

  return { scores, inboundByAccount, outboundByAccount };
}

function bfsDepth(
  origins: Set<string>,
  outboundByAccount: Map<string, GraphVouch[]>,
  accounts: GraphAccount[],
): Map<string, number> {
  const depth = new Map<string, number>();
  let frontier = new Set(origins);
  for (const id of frontier) depth.set(id, 0);
  const validIds = new Set(accounts.map((a) => a.id));

  for (let d = 1; d <= MAX_DEPTH; d++) {
    const next = new Set<string>();
    for (const id of frontier) {
      for (const edge of outboundByAccount.get(id) ?? []) {
        if (!validIds.has(edge.voucheeId)) continue;
        if (depth.has(edge.voucheeId)) continue;
        depth.set(edge.voucheeId, d);
        next.add(edge.voucheeId);
      }
    }
    frontier = next;
    if (frontier.size === 0) break;
  }
  return depth;
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

// ── breakdown rows (docs/06-mcp-skills.md §2.2) ──────────────────────────

export interface BreakdownRow {
  voucher: string; // canonical name if resolvable, else address
  voucherScore: number;
  voucherDepth: number;
  raw: number;
  capped: boolean;
  contribution: number;
  expiresAt?: string;
  counted: boolean;
  reason?: string;
}

export function deriveBreakdown(
  address: string,
  graph: TrustGraph,
  scored: Scored,
  nameOf: (address: string) => string,
): { breakdown: BreakdownRow[]; base: number } {
  const target = scored.scores.get(address);
  const targetDepth = target?.depth ?? MAX_DEPTH + 1;
  const rows: BreakdownRow[] = [];

  for (const edge of scored.inboundByAccount.get(address) ?? []) {
    const voucher = scored.scores.get(edge.voucherId);
    const voucherScore = voucher?.score ?? BASE;
    const voucherDepth = voucher?.depth ?? MAX_DEPTH + 1;
    const { raw, capped, contribution } = w(voucherScore);
    const counted = voucherDepth < targetDepth;
    const row: BreakdownRow = {
      voucher: nameOf(edge.voucherId),
      voucherScore,
      voucherDepth,
      raw,
      capped,
      contribution: counted ? contribution : 0,
      counted,
    };
    if (counted) {
      row.expiresAt = secondsToIso(edge.expiresAt);
    } else {
      row.reason = "voucher_depth_not_lower";
    }
    rows.push(row);
  }

  return { breakdown: rows, base: BASE };
}

export function secondsToIso(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString();
}

// ── identifier resolution (ENS name / address / handle) ─────────────────

export function isLikelyAddress(identifier: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(identifier);
}

export function isLikelyEnsName(identifier: string): boolean {
  return identifier.endsWith(".aval.eth") || identifier.endsWith(".eth");
}

/** Resolves an ENS name, a bare handle, or an address to a lowercase address, or null. */
export function resolveIdentifierToAddress(identifier: string, graph: TrustGraph): string | null {
  if (isLikelyAddress(identifier)) return identifier.toLowerCase();

  const label = identifier.endsWith(".aval.eth")
    ? identifier.slice(0, -".aval.eth".length).split(".")[0]
    : identifier.replace(/\.eth$/, "");

  // Prefer an exact handle match; if ambiguous, the caller's `aval_resolve`
  // reports `canonicalName` computed from the full path anyway.
  const match = graph.accounts.find((a) => a.handle === label);
  return match ? match.id : null;
}

// ── calling the real engine ───────────────────────────────────────────

/**
 * Loose, defensive shape of what @aval/engine's compute() returns — see
 * the module comment above. Every field is read optionally.
 */
interface EngineOutputShape {
  score?: Record<string, number>;
  tier?: Record<string, number>;
  depth?: Record<string, number>;
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

export function runEngineCompute(graph: TrustGraph, now: bigint): unknown {
  const accounts: Account[] = graph.accounts.map((a) => ({
    id: a.id,
    // GRAPH_QUERY above only indexes AvalRegistry (human) accounts — PlatformRegistry accounts
    // are a separate, unqueried data source (see this file's module comment and context.ts's
    // matching note in @aval/gateway) — so every account reaching this function is human.
    kind: "human" as const,
    isAnchor: a.isAnchor,
  }));
  const vouches: Vouch[] = graph.vouches.map((v) => ({
    voucher: v.voucherId,
    vouchee: v.voucheeId,
    // GRAPH_QUERY's `outbound(where: { revoked: false, expiresAt_gt: $now })` already excludes
    // revoked and expired edges at query time, so every vouch reaching this function is active
    // by construction (see this file's `TrustGraph.vouches` doc comment).
    active: true,
  }));
  const input: EngineInput = {
    accounts,
    vouches,
    platformVouches: [],
    reports: [],
    now: bigintSecondsToEngineNow(now),
  };
  return compute(input);
}

// ── naming: canonical name, aliases, paths (docs/04-ens.md §1.1, §3.1) ──

export interface NamedPath {
  name: string; // e.g. "carol.alice.aval.eth"
  depth: number;
  oldestIssuedAt: bigint;
  addresses: string[]; // root to leaf, this account's address last
}

/** Enumerates every anchor-rooted path to `address`, up to MAX_DEPTH hops. */
export function findAllPaths(address: string, graph: TrustGraph, scored: Scored): NamedPath[] {
  const target = address.toLowerCase();
  const handleById = new Map(graph.accounts.map((a) => [a.id, a.handle] as const));
  const anchors = graph.accounts.filter((a) => a.isAnchor).map((a) => a.id);
  const results: NamedPath[] = [];

  function walk(currentId: string, labelsRootFirst: string[], addrs: string[], oldest: bigint, depth: number): void {
    if (currentId === target && depth > 0) {
      results.push({
        name: [...labelsRootFirst].concat(["aval", "eth"]).join("."),
        depth,
        oldestIssuedAt: oldest,
        addresses: addrs,
      });
    }
    if (depth >= MAX_DEPTH) return;
    for (const edge of scored.outboundByAccount.get(currentId) ?? []) {
      const handle = handleById.get(edge.voucheeId);
      if (!handle) continue;
      walk(
        edge.voucheeId,
        [...labelsRootFirst, handle],
        [...addrs, edge.voucheeId],
        oldest < edge.issuedAt ? oldest : edge.issuedAt,
        depth + 1,
      );
    }
  }

  for (const anchor of anchors) walk(anchor, [], [], 2n ** 63n - 1n, 0);
  return results;
}

export function pickCanonicalName(paths: NamedPath[]): NamedPath | null {
  if (paths.length === 0) return null;
  return [...paths].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.oldestIssuedAt !== b.oldestIssuedAt) return a.oldestIssuedAt < b.oldestIssuedAt ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  })[0]!;
}

/** Canonical name if one exists, else the bare address — used anywhere a "name" is displayed. */
export function nameOf(address: string, graph: TrustGraph, scored: Scored): string {
  const canonical = pickCanonicalName(findAllPaths(address, graph, scored));
  return canonical?.name ?? address;
}

// ── shortest path between two accounts, or to the nearest anchor ────────

export interface PathHop {
  address: string;
  name: string;
  depth: number;
}

export interface PathResult {
  hops: PathHop[];
  length: number;
  weakestLink: { voucher: string; vouchee: string; expiresAt: string } | null;
}

/**
 * Shortest active-vouch path from `from` to `to` (or, when `to ===
 * "anchor"`, to the nearest anchor), via plain BFS over outbound edges.
 * docs/06 §2.6: "the ENS names along the path... just the target's
 * canonical name decomposed" — for a direct anchor-rooted path that's
 * literally true; for an arbitrary from->to pair (which need not start at
 * an anchor) we still return address + best-effort name per hop.
 */
export function findPath(from: string, to: string, graph: TrustGraph, scored: Scored): PathResult | null {
  const start = from.toLowerCase();
  const anchors = new Set(graph.accounts.filter((a) => a.isAnchor).map((a) => a.id));
  const isTarget = to === "anchor" ? (id: string) => anchors.has(id) : (id: string) => id === to.toLowerCase();

  if (isTarget(start)) {
    return { hops: [{ address: start, name: nameOf(start, graph, scored), depth: 0 }], length: 0, weakestLink: null };
  }

  const prevEdge = new Map<string, GraphVouch>();
  const visited = new Set<string>([start]);
  let frontier = [start];

  for (let d = 1; d <= MAX_DEPTH + 1 && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of scored.outboundByAccount.get(id) ?? []) {
        if (visited.has(edge.voucheeId)) continue;
        visited.add(edge.voucheeId);
        prevEdge.set(edge.voucheeId, edge);
        if (isTarget(edge.voucheeId)) {
          return buildPathResult(edge.voucheeId, prevEdge, graph, scored);
        }
        next.push(edge.voucheeId);
      }
    }
    frontier = next;
  }
  return null; // no path within MAX_DEPTH+1 hops
}

function buildPathResult(
  endId: string,
  prevEdge: Map<string, GraphVouch>,
  graph: TrustGraph,
  scored: Scored,
): PathResult {
  const chain: GraphVouch[] = [];
  let cursor: string | undefined = endId;
  while (cursor !== undefined && prevEdge.has(cursor) && chain.length <= MAX_DEPTH + 2) {
    const edge: GraphVouch = prevEdge.get(cursor)!;
    chain.unshift(edge);
    cursor = edge.voucherId; // walk back to the predecessor; loop ends once it's the BFS start (no prevEdge entry)
  }

  const hops: PathHop[] = [];
  const startId = chain[0]?.voucherId ?? endId;
  hops.push({ address: startId, name: nameOf(startId, graph, scored), depth: scored.scores.get(startId)?.depth ?? 0 });
  for (const edge of chain) {
    hops.push({
      address: edge.voucheeId,
      name: nameOf(edge.voucheeId, graph, scored),
      depth: scored.scores.get(edge.voucheeId)?.depth ?? hops.length,
    });
  }

  const weakest = chain.reduce<GraphVouch | null>(
    (min, e) => (min === null || e.expiresAt < min.expiresAt ? e : min),
    null,
  );

  return {
    hops,
    length: chain.length,
    weakestLink: weakest
      ? { voucher: nameOf(weakest.voucherId, graph, scored), vouchee: nameOf(weakest.voucheeId, graph, scored), expiresAt: secondsToIso(weakest.expiresAt) }
      : null,
  };
}

// ── candidates: who could vouch for `address` next (docs/06 §2.7) ───────

export interface Candidate {
  candidate: string; // name
  distance: number;
  freeSlots: number;
  wouldPromote: boolean;
  sharedNeighbours: number;
}

/**
 * Accounts within 2 hops of `address`'s existing vouchers, with free
 * slots, at a depth low enough to actually contribute if they vouched.
 */
export function findCandidates(address: string, graph: TrustGraph, scored: Scored): Candidate[] {
  const target = address.toLowerCase();
  const targetResult = scored.scores.get(target);
  const targetDepth = targetResult?.depth ?? MAX_DEPTH + 1;
  const existingVouchers = new Set((scored.inboundByAccount.get(target) ?? []).map((e) => e.voucherId));

  // 2-hop neighbourhood: vouchers of my vouchers, and their vouchees.
  const twoHop = new Set<string>();
  for (const voucherId of existingVouchers) {
    for (const e of scored.inboundByAccount.get(voucherId) ?? []) twoHop.add(e.voucherId);
    for (const e of scored.outboundByAccount.get(voucherId) ?? []) twoHop.add(e.voucheeId);
  }
  twoHop.delete(target);
  for (const v of existingVouchers) twoHop.delete(v);

  const results: Candidate[] = [];
  for (const candidateId of twoHop) {
    const result = scored.scores.get(candidateId);
    if (!result) continue;
    if (result.depth >= targetDepth && targetDepth <= MAX_DEPTH) continue; // wouldn't lower the target's effective depth requirement
    const account = graph.accounts.find((a) => a.id === candidateId);
    const usedSlots = account?.activeOutboundCount ?? 0;
    const freeSlots = Math.max(0, slotsFor(result.tier) - usedSlots);
    if (freeSlots <= 0) continue;

    const candidateNeighbours = new Set([
      ...(scored.inboundByAccount.get(candidateId) ?? []).map((e) => e.voucherId),
      ...(scored.outboundByAccount.get(candidateId) ?? []).map((e) => e.voucheeId),
    ]);
    const sharedNeighbours = [...existingVouchers].filter((v) => candidateNeighbours.has(v)).length;

    const { contribution } = w(result.score);
    const wouldPromote = targetResult ? targetResult.score + contribution >= T1 && targetResult.score < T1 : false;

    results.push({
      candidate: nameOf(candidateId, graph, scored),
      distance: result.depth <= targetDepth ? 1 : 2,
      freeSlots,
      wouldPromote,
      sharedNeighbours,
    });
  }

  return results.sort((a, b) => b.sharedNeighbours - a.sharedNeighbours);
}

export function preferEngineResult(engineOutput: unknown, address: string, fallback: ScoreResult): ScoreResult {
  const out = (engineOutput ?? {}) as EngineOutputShape;
  const score = out.score?.[address];
  if (score === undefined) return fallback;
  const tier = out.tier?.[address] ?? (score >= T2 ? 2 : score >= T1 ? 1 : 0);
  const depth = out.depth?.[address] ?? fallback.depth;
  return { score, tier: tier as 0 | 1 | 2, depth };
}
