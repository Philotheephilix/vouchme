// @aval/mcp — src/engine.ts
//
// Shared graph fetch + scoring wiring used by every tool in src/tools/*.ts.
//
// The trust graph itself comes from src/chain.ts — live World Chain Sepolia reads, since no
// Subgraph is deployed (see chain.ts's own module comment). `getCachedGraph`/`fetchGraph` are
// re-exported from there unchanged so every tool file's existing `import { getCachedGraph } from
// "../engine.js"` keeps working.
//
// Per docs/06-mcp-skills.md §7 build checklist ("Engine imported as a library — the same code the
// gateway runs, so the MCP and ENS never disagree"), EVERY score/tier/depth number in this server
// — including the ones `scoreGraph()` further down hands to path-finding (aval_path),
// candidate-voucher discovery (aval_candidates), and ENS-style naming (aval_resolve's aliases) —
// comes from `@aval/engine`'s own `compute()` and `breakdown()`. `scoreGraph()` is not a second
// implementation of the trust math: it only indexes the edge list (inbound/outbound per account,
// which @aval/engine has no notion of) and then looks up each account's score/tier/depth from a
// real `computeEngine()` call. No threshold (T1, T2, BASE, CAP_POS, ...) is ever hardcoded here —
// every constant below is derived from `@aval/engine`'s own exports, so a docs/10-constants.md
// change is picked up automatically everywhere in this file.

import {
  compute,
  breakdown as engineBreakdown,
  CAP_POS_BINDING_THRESHOLD,
  BASE as BASE_CENTI,
  ANCHOR as ANCHOR_CENTI,
  T1 as T1_CENTI,
  T2 as T2_CENTI,
  P1 as P1_CENTI,
  P2 as P2_CENTI,
  CAP_POS as CAP_POS_CENTI,
  M_POS_NUM,
  M_POS_DEN,
  MAX_DEPTH as ENGINE_MAX_DEPTH,
  MAX_ROUNDS as ENGINE_MAX_ROUNDS,
  SLOTS_TIER_0,
  SLOTS_TIER_1,
  SLOTS_TIER_2,
} from "@aval/engine";
import type { Account, EngineInput, EngineOutput, ScoreBreakdown, Vouch } from "@aval/engine";
import {
  fetchGraph as chainFetchGraph,
  getCachedGraph as chainGetCachedGraph,
  checkAnchorStatusLive,
  type GraphAccount,
  type GraphVouch,
  type TrustGraph,
} from "./chain.js";

export const fetchGraph = chainFetchGraph;
export const getCachedGraph = chainGetCachedGraph;
export { checkAnchorStatusLive };
export type { GraphAccount, GraphVouch, TrustGraph };

// ── constants — DERIVED from @aval/engine's own exports, never a second, independently-hardcoded
// number: score thresholds are always read from the engine, never retyped. Decimal-point scale
// (score, not centi-points) — the scale every tool JSON response and docs/06's own examples
// (e.g. "62.5") use.
// `centiToDecimal()` below is the one seam where @aval/engine's centi-point output crosses into
// this scale. If docs/10-constants.md's thresholds change, every one of these follows
// automatically because each reads the same @aval/engine import, not a retyped literal. ──────────
export const BASE = BASE_CENTI / 100;
export const ANCHOR_SCORE = ANCHOR_CENTI / 100;
export const M_POS = M_POS_NUM / M_POS_DEN;
export const CAP_POS = CAP_POS_CENTI / 100;
export const T1 = T1_CENTI / 100;
export const T2 = T2_CENTI / 100;
export const P1 = P1_CENTI / 100; // platform Tier 1 threshold
export const P2 = P2_CENTI / 100; // platform Tier 2 threshold
export const MAX_DEPTH = ENGINE_MAX_DEPTH;
export const MAX_ROUNDS = ENGINE_MAX_ROUNDS;
export function slotsFor(tier: 0 | 1 | 2): number {
  return tier === 2 ? SLOTS_TIER_2 : tier === 1 ? SLOTS_TIER_1 : SLOTS_TIER_0;
}

// ── calling the real engine ──────────────────────────────────────────────────────────────────

function bigintSecondsToEngineNow(seconds: bigint): number {
  if (seconds > BigInt(Number.MAX_SAFE_INTEGER) || seconds < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new RangeError(`timestamp ${seconds.toString()} exceeds Number.MAX_SAFE_INTEGER — cannot pass to @aval/engine`);
  }
  return Number(seconds);
}

/** Converts @aval/engine's integer centi-points (score × 100, engine/src/types.ts) into the
 *  decimal points every tool response uses. The only unit conversion in this file — every other
 *  function here is unambiguously either centi (talking to @aval/engine) or decimal (talking to a
 *  tool response). */
function centiToDecimal(centi: number): number {
  return centi / 100;
}

/** Builds the exact EngineInput @aval/engine's compute() expects from an already-active-filtered,
 *  already-deduplicated-by-pair TrustGraph (see chain.ts's own doc comment — every graph.vouches
 *  entry reaching this function is live chain data, not subgraph data). `extraVouches` lets
 *  aval_simulate_vouch.ts append one synthetic edge without mutating the cached graph. */
export function buildEngineInput(graph: TrustGraph, now: bigint, extraVouches: GraphVouch[] = []): EngineInput {
  const accounts: Account[] = graph.accounts.map((a) => ({ id: a.id, kind: "human" as const, isAnchor: a.isAnchor }));
  const vouches: Vouch[] = [...graph.vouches, ...extraVouches].map((v) => ({
    voucher: v.voucherId,
    vouchee: v.voucheeId,
    // GraphVouch is already active-filtered at fetch time (chain.ts) — see TrustGraph's own doc
    // comment — so every vouch reaching this function is active by construction.
    active: true,
  }));
  return { accounts, vouches, platformVouches: [], reports: [], now: bigintSecondsToEngineNow(now) };
}

export interface EngineComputation {
  input: EngineInput;
  output: EngineOutput;
}

/** Runs the real @aval/engine compute() — the ONLY place this package computes a score. Returns
 *  both the EngineInput used and the EngineOutput, since @aval/engine's own breakdown() (used by
 *  deriveBreakdown() below) needs both. */
export function computeEngine(graph: TrustGraph, now: bigint, extraVouches: GraphVouch[] = []): EngineComputation {
  const input = buildEngineInput(graph, now, extraVouches);
  return { input, output: compute(input) };
}

export interface EngineScoreResult {
  score: number; // decimal points
  tier: 0 | 1 | 2;
  /** May be `Infinity` for an unreachable account — render as `"unreachable"` at the JSON
   *  boundary (see depthForJson below), never let it silently become `null` via JSON.stringify. */
  depth: number;
}

/** The authoritative score/tier/depth for one address, straight off @aval/engine's own output.
 *  Returns null if `address` isn't a human account in this computation (callers that already
 *  confirmed `address` came from `graph.accounts` should never see null here). */
export function engineScoreResult(output: EngineOutput, address: string): EngineScoreResult | null {
  const score = output.score[address];
  if (score === undefined) return null;
  return {
    score: centiToDecimal(score),
    tier: output.tier[address] ?? 0,
    depth: output.depth[address] ?? Number.POSITIVE_INFINITY,
  };
}

/** JSON-safe rendering of a depth that may be `Infinity` — `JSON.stringify(Infinity)` silently
 *  produces `null`, which would look like a missing field rather than "unreachable." */
export function depthForJson(depth: number): number | "unreachable" {
  return Number.isFinite(depth) ? depth : "unreachable";
}

// ── breakdown rows (docs/06-mcp-skills.md §2.2), engine-backed ──────────────────────────────────

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

/** Per-voucher breakdown for `address`, straight from @aval/engine's own breakdown() (explain.ts)
 *  — never a local reimplementation of the contribution math. `expiresAt` for counted rows is
 *  read back from the raw TrustGraph edges (the engine's Vouch type carries no timestamps by
 *  design — docs/01-trust-math.md §18 — so this is metadata, not math). */
export function deriveBreakdown(
  address: string,
  graph: TrustGraph,
  engineIO: EngineComputation,
  nameFor: (address: string) => string,
): { breakdown: BreakdownRow[]; base: number } {
  const sb: ScoreBreakdown = engineBreakdown(address, engineIO.input, engineIO.output);

  const expiresAtByVoucher = new Map<string, bigint>();
  for (const v of graph.vouches) {
    if (v.voucheeId === address) expiresAtByVoucher.set(v.voucherId, v.expiresAt);
  }

  const rows: BreakdownRow[] = sb.vouchers.map((v) => {
    const capped = v.voucherSPlus !== undefined && v.voucherSPlus > CAP_POS_BINDING_THRESHOLD;
    const voucherDepthFinite =
      v.voucherDepth !== undefined && Number.isFinite(v.voucherDepth) ? v.voucherDepth : MAX_DEPTH + 1;
    const row: BreakdownRow = {
      voucher: nameFor(v.voucher),
      voucherScore: v.voucherSPlus !== undefined ? centiToDecimal(v.voucherSPlus) : 0,
      voucherDepth: voucherDepthFinite,
      raw: centiToDecimal(v.rawContribution),
      capped,
      contribution: centiToDecimal(v.contribution),
      counted: v.counted,
    };
    if (v.counted) {
      const expiresAt = expiresAtByVoucher.get(v.voucher);
      if (expiresAt !== undefined) row.expiresAt = secondsToIso(expiresAt);
    } else if (v.reason !== "counted") {
      row.reason = v.reason;
    }
    return row;
  });

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

/**
 * The bare ENS label a `handle` should be matched against.
 *
 * `AvalRegistry.enroll()`'s own doc comment describes `handle` as "ENS label, validated
 * off-chain" — a bare label like "alice" — but this live deployment's actual enrollment script
 * (scripts/live-scenario.mjs: `const handle = \`${label}.aval.eth\`;`) writes the FULL name
 * on-chain instead, e.g. "alice.aval.eth". Both conventions are tolerated here (bare label
 * unchanged; "<label>.aval.eth" stripped to its first segment) so name lookups resolve against
 * this deployment's actual data without assuming every future enrollment repeats the same
 * (spec-deviating) convention.
 */
function bareLabel(handle: string): string {
  const suffix = ".aval.eth";
  return handle.endsWith(suffix) ? handle.slice(0, -suffix.length) : handle;
}

/** Resolves an ENS name, a bare handle, or an address to a lowercase address, or null. */
export function resolveIdentifierToAddress(identifier: string, graph: TrustGraph): string | null {
  if (isLikelyAddress(identifier)) return identifier.toLowerCase();

  const label = identifier.endsWith(".aval.eth")
    ? identifier.slice(0, -".aval.eth".length).split(".")[0]
    : identifier.replace(/\.eth$/, "");

  // Prefer an exact handle match; if ambiguous, the caller's `aval_resolve`
  // reports `canonicalName` computed from the full path anyway.
  const match = graph.accounts.find((a) => bareLabel(a.handle) === label);
  return match ? match.id : null;
}

// ── edge index + engine-backed scores — path-finding / candidate-discovery / naming support. ────
//
// `scoreGraph()` only builds the inbound/outbound edge index (pure graph structure — @aval/engine
// has no notion of "the edge from X to Y", only aggregate scores) and borrows every
// score/tier/depth number straight from a real `computeEngine()` call. There is exactly one
// implementation of the scoring math in this server, in @aval/engine, and it is never re-derived —
// including for the numbers findPath/findCandidates/aval_platform/aval_report use to rank or gate
// on.

export interface ScoreResult {
  score: number; // decimal points, from the real engine
  tier: 0 | 1 | 2;
  depth: number; // 0 for anchors, Number.POSITIVE_INFINITY if unreachable
}

export interface Scored {
  scores: Map<string, ScoreResult>;
  inboundByAccount: Map<string, GraphVouch[]>;
  outboundByAccount: Map<string, GraphVouch[]>;
}

function w(score: number): { raw: number; capped: boolean; contribution: number } {
  const raw = score * M_POS;
  const capped = raw > CAP_POS;
  return { raw, capped, contribution: Math.min(raw, CAP_POS) };
}

/** Builds the edge index and looks up every account's real score/tier/depth from a fresh
 *  `computeEngine()` call (`now` defaults to the current wall clock — callers that already have an
 *  `EngineComputation` from elsewhere in the same request should prefer reading `output` directly
 *  rather than calling this a second time). */
export function scoreGraph(graph: TrustGraph, now: bigint = BigInt(Math.floor(Date.now() / 1000))): Scored {
  const inboundByAccount = new Map<string, GraphVouch[]>();
  const outboundByAccount = new Map<string, GraphVouch[]>();
  for (const v of graph.vouches) {
    (inboundByAccount.get(v.voucheeId) ?? inboundByAccount.set(v.voucheeId, []).get(v.voucheeId)!).push(v);
    (outboundByAccount.get(v.voucherId) ?? outboundByAccount.set(v.voucherId, []).get(v.voucherId)!).push(v);
  }

  const output = computeEngine(graph, now).output;
  const scores = new Map<string, ScoreResult>();
  for (const a of graph.accounts) {
    const centi = output.score[a.id];
    if (centi === undefined) continue; // not scored by the engine (e.g. filtered as inactive)
    scores.set(a.id, {
      score: centiToDecimal(centi),
      tier: output.tier[a.id] ?? 0,
      depth: output.depth[a.id] ?? Number.POSITIVE_INFINITY,
    });
  }

  return { scores, inboundByAccount, outboundByAccount };
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
        [...labelsRootFirst, bareLabel(handle)],
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
