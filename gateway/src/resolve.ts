// @aval/gateway — src/resolve.ts
//
// ENSIP-10 wildcard resolution for *.aval.eth.
//
// The name IS the edge (docs/04-ens.md §1): `carol.alice.aval.eth` means
// "Alice vouched for Carol." Depth is label count. There is no name
// registry to look up — every name is *derived* live from the trust graph
// by walking labels from `aval.eth` down to the leaf, matching each label
// against an account's immutable `handle` among the previous hop's active
// vouchees (or, for the first hop, among any anchor's active vouchees).
//
// This module also implements the CCIP-Read (ERC-3668) request decoding:
// the L1 resolver reverts OffchainLookup with callData equal to the
// arguments of `resolve(bytes name, bytes data)` (ENSIP-10's
// IExtendedResolver), and the gateway is called at
// `GET /{sender}/{data}.json` where `{data}` is that same callData
// ABI-encoded. We decode it here, resolve the record, and hand the raw
// ABI-encoded result to src/sign.ts for signing.

import {
  decodeFunctionData,
  encodeAbiParameters,
  type Address,
  type Hex,
} from "viem";
import type { NamingSnapshot } from "./subgraph.js";

export const MAX_DEPTH = 3; // docs/10-constants.md §3 — also the ENS label-count limit

// ── ABI fragments for the outer wildcard call and the inner record calls ──

const RESOLVE_ABI = [
  {
    name: "resolve",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "name", type: "bytes" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "result", type: "bytes" }],
  },
] as const;

const TEXT_ABI = {
  name: "text",
  type: "function",
  stateMutability: "view",
  inputs: [
    { name: "node", type: "bytes32" },
    { name: "key", type: "string" },
  ],
  outputs: [{ name: "value", type: "string" }],
} as const;

const ADDR_ABI = {
  name: "addr",
  type: "function",
  stateMutability: "view",
  inputs: [{ name: "node", type: "bytes32" }],
  outputs: [{ name: "value", type: "address" }],
} as const;

const RECORD_ABI = [TEXT_ABI, ADDR_ABI] as const;

// ── DNS wire-format name decoding ──────────────────────────────────────

/**
 * Decodes an ENSIP-10 DNS-wire-format name into its labels, leftmost
 * (most specific) label first — e.g. "carol.alice.aval.eth" decodes to
 * ["carol", "alice", "aval", "eth"].
 */
export function decodeDnsName(nameBytes: Uint8Array): string[] {
  const labels: string[] = [];
  let i = 0;
  while (i < nameBytes.length) {
    const len = nameBytes[i];
    if (len === undefined) break;
    if (len === 0) break;
    i += 1;
    const labelBytes = nameBytes.slice(i, i + len);
    labels.push(new TextDecoder().decode(labelBytes));
    i += len;
  }
  return labels;
}

/** Inverse of decodeDnsName, useful for tests and for building requests. */
export function encodeDnsName(labels: string[]): Uint8Array {
  const parts: number[] = [];
  for (const label of labels) {
    const bytes = new TextEncoder().encode(label);
    if (bytes.length === 0 || bytes.length > 255) {
      throw new Error(`invalid DNS label length: ${label}`);
    }
    parts.push(bytes.length, ...bytes);
  }
  parts.push(0);
  return new Uint8Array(parts);
}

// ── depth + path -------------------------------------------------------

export interface ParsedName {
  /** Full label list, leaf first, e.g. ["carol", "alice", "aval", "eth"]. */
  labels: string[];
  /** Labels under the root, leaf first, e.g. ["carol", "alice"]. Empty for aval.eth itself. */
  pathLabelsLeafFirst: string[];
  /** Same labels, root-to-leaf order, e.g. ["alice", "carol"] — the order vouches were issued in. */
  pathLabelsRootFirst: string[];
  /** Label count under the root == BFS depth (docs/04-ens.md §1). */
  depth: number;
}

/**
 * Validates the name is under `aval.eth` and within MAX_DEPTH, and returns
 * the parsed path. Returns null for anything else — per docs/04-ens.md
 * §5.1, `x.y.z.w.aval.eth` (depth 4) simply does not resolve; the attack
 * (or the typo) is unrepresentable in the namespace, not rejected by a
 * runtime check we could get wrong.
 */
export function parseName(nameBytes: Uint8Array): ParsedName | null {
  const labels = decodeDnsName(nameBytes);
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  const root = labels[labels.length - 2];
  if (tld !== "eth" || root !== "aval") return null;

  const pathLabelsLeafFirst = labels.slice(0, labels.length - 2);
  const depth = pathLabelsLeafFirst.length;
  if (depth > MAX_DEPTH) return null; // beyond max_depth: does not resolve

  return {
    labels,
    pathLabelsLeafFirst,
    pathLabelsRootFirst: [...pathLabelsLeafFirst].reverse(),
    depth,
  };
}

// ── walking the trust graph by handle ----------------------------------

/**
 * The bare ENS label a `handle` should be matched/displayed as.
 *
 * `AvalRegistry.enroll()`'s own doc comment describes `handle` as "ENS label, validated
 * off-chain" — i.e. a bare label like "alice" — but this live deployment's actual enrollment
 * script (scripts/live-scenario.mjs: `const handle = \`${label}.aval.eth\`;`) writes the FULL
 * name on-chain instead, e.g. "alice.aval.eth". Both conventions are tolerated here (bare label
 * unchanged; "<label>.aval.eth" stripped to its first segment) so this deployment's data resolves
 * without assuming every future enrollment repeats the same spec deviation.
 */
export function bareLabel(handle: string): string {
  const suffix = ".aval.eth";
  return handle.endsWith(suffix) ? handle.slice(0, -suffix.length) : handle;
}

export interface ResolvedIdentity {
  address: Address;
  depth: number;
  /** All accounts on the path, root to leaf, address only. */
  pathAddresses: Address[];
}

/**
 * Walks `aval.eth` -> ... -> leaf by handle, matching docs/04-ens.md §1's
 * claim that "path to an anchor" is just reading the name left to right.
 *
 * At each step we need "did the current frontier issue an active vouch to
 * an account whose handle matches this label?" — handles are not globally
 * unique (docs/04 §6: "per parent, siblings must differ; globally
 * advisory"), so in the (rare, discouraged) case of a global handle
 * collision we deterministically prefer the qualifying vouch issued
 * earliest, then the lexicographically lowest vouchee address, mirroring
 * the canonical-name tie-break rule in docs/04 §3.1 / §8 ("shortest, then
 * oldest, then lexicographic").
 */
export function resolveNameToAddress(
  parsed: ParsedName,
  graph: NamingSnapshot,
): ResolvedIdentity | null {
  if (parsed.depth === 0) return null; // aval.eth itself has no owner account

  const handleById = new Map(graph.accounts.map((a) => [a.id, a.handle] as const));
  const anchors = new Set(graph.accounts.filter((a) => a.isAnchor).map((a) => a.id));

  let frontier: Set<string> = anchors;
  const pathAddresses: Address[] = [];
  let currentId: string | null = null;

  for (const label of parsed.pathLabelsRootFirst) {
    let best: { edge: (typeof graph.edges)[number] } | null = null;
    for (const edge of graph.edges) {
      if (!frontier.has(edge.voucherId)) continue;
      const handle = handleById.get(edge.voucheeId);
      if (handle === undefined || bareLabel(handle) !== label) continue;
      if (
        !best ||
        edge.issuedAt < best.edge.issuedAt ||
        (edge.issuedAt === best.edge.issuedAt && edge.voucheeId < best.edge.voucheeId)
      ) {
        best = { edge };
      }
    }
    if (!best) return null; // no vouch satisfies this hop — name does not resolve
    currentId = best.edge.voucheeId;
    pathAddresses.push(currentId as Address);
    frontier = new Set([currentId]); // next label must be vouched by exactly this account
  }

  if (!currentId) return null;
  return { address: currentId as Address, depth: parsed.depth, pathAddresses };
}

export interface NamedPath {
  /** e.g. "carol.alice.aval.eth" */
  name: string;
  depth: number;
  oldestIssuedAt: bigint;
}

/**
 * Enumerates every path from an anchor to `address` up to MAX_DEPTH hops,
 * for canonical-name selection and for `aliases` (docs/04-ens.md §1.1).
 * The graph is small enough (10^4 accounts, docs/05 §2.2) that a bounded
 * depth-first walk over the whole edge set is cheap and simple beats
 * clever here.
 */
export function findAllPaths(address: Address, graph: NamingSnapshot): NamedPath[] {
  const handleById = new Map(graph.accounts.map((a) => [a.id, a.handle] as const));
  const anchors = new Set(graph.accounts.filter((a) => a.isAnchor).map((a) => a.id));
  const outboundByVoucher = new Map<string, typeof graph.edges>();
  for (const edge of graph.edges) {
    const list = outboundByVoucher.get(edge.voucherId) ?? [];
    list.push(edge);
    outboundByVoucher.set(edge.voucherId, list);
  }

  const target = address.toLowerCase();
  const results: NamedPath[] = [];

  function walk(
    currentId: string,
    labelsRootFirst: string[],
    oldestIssuedAt: bigint,
    depth: number,
  ): void {
    if (currentId === target && depth > 0) {
      results.push({
        name: [...labelsRootFirst].reverse().concat(["aval", "eth"]).join("."),
        depth,
        oldestIssuedAt,
      });
      // A qualifying account can still be an intermediate hop for a
      // *different* alias path only via a different vouch edge, which the
      // loop below already explores independently — no early return needed
      // beyond the depth bound.
    }
    if (depth >= MAX_DEPTH) return;
    for (const edge of outboundByVoucher.get(currentId) ?? []) {
      const handle = handleById.get(edge.voucheeId);
      if (!handle) continue;
      walk(
        edge.voucheeId,
        [...labelsRootFirst, bareLabel(handle)],
        oldestIssuedAt < edge.issuedAt ? oldestIssuedAt : edge.issuedAt,
        depth + 1,
      );
    }
  }

  for (const anchor of anchors) {
    walk(anchor, [], (2n ** 63n - 1n), 0);
  }

  return results;
}

/**
 * Picks the canonical name among all paths to `address`: shortest, then
 * oldest, then lexicographic (docs/04-ens.md §3.1 and §8, "deterministic").
 */
export function pickCanonicalName(paths: NamedPath[]): NamedPath | null {
  if (paths.length === 0) return null;
  return [...paths].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    if (a.oldestIssuedAt !== b.oldestIssuedAt) return a.oldestIssuedAt < b.oldestIssuedAt ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  })[0]!;
}

// ── CCIP-Read request decoding -------------------------------------------

export interface DecodedCcipRequest {
  name: ParsedName;
  kind: "text" | "addr";
  node: Hex;
  /** Only present for text(node, key). */
  key?: string;
  /** The original, undecoded outer calldata — re-signed into the response per ERC-3668. */
  rawRequest: Hex;
}

export class UnsupportedRecordError extends Error {}
export class MalformedRequestError extends Error {}

/**
 * Decodes the `{sender}/{data}` CCIP-Read gateway request into a resolved
 * (name, record-kind) pair. `sender` is expected to be the resolver
 * contract address (unused for computation, but is part of the signed
 * payload per SignatureVerifier's EIP-191 scheme — see src/sign.ts).
 */
export function decodeCcipRequest(dataHex: Hex): DecodedCcipRequest {
  let outer;
  try {
    outer = decodeFunctionData({ abi: RESOLVE_ABI, data: dataHex });
  } catch (err) {
    throw new MalformedRequestError(`could not decode outer resolve() call: ${String(err)}`);
  }
  const [dnsName, innerData] = outer.args;
  const parsed = parseName(hexToBytes(dnsName));
  if (!parsed) {
    throw new MalformedRequestError("name is not under aval.eth or exceeds max_depth");
  }

  let inner;
  try {
    inner = decodeFunctionData({ abi: RECORD_ABI, data: innerData });
  } catch (err) {
    throw new UnsupportedRecordError(`unsupported resolver function: ${String(err)}`);
  }

  if (inner.functionName === "text") {
    const [node, key] = inner.args;
    return { name: parsed, kind: "text", node, key, rawRequest: dataHex };
  }
  const [node] = inner.args;
  return { name: parsed, kind: "addr", node, rawRequest: dataHex };
}

function hexToBytes(hex: Hex): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** ABI-encodes the resolver's return value the same way the on-chain resolver would. */
export function encodeTextResult(value: string): Hex {
  return encodeAbiParameters([{ type: "string" }], [value]);
}

export function encodeAddrResult(value: Address): Hex {
  return encodeAbiParameters([{ type: "address" }], [value]);
}
