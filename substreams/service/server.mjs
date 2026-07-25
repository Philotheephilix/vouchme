#!/usr/bin/env node
// substreams/service/server.mjs
//
// Read-only HTTP surface over the trust_edges sink database — the ONE documented interface the
// app is meant to consume. Owned entirely by substreams/; the app never imports Rust or talks to
// ClickHouse directly. See ../README.md for the full contract (endpoints, response shapes, how to
// run this).
//
// No framework, no dependencies — built-in `http` + `fetch` against ClickHouse's HTTP interface
// (default port 8123). Keeping this dependency-free means `node server.mjs` is the entire
// deployment story.

import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 8790); // 3000 and 8788 are taken; 8790+ is clear
const CLICKHOUSE_HTTP_URL = process.env.CLICKHOUSE_HTTP_URL ?? "http://localhost:8123";
const CLICKHOUSE_DATABASE = process.env.CLICKHOUSE_DATABASE ?? "default";
const TABLE = "trust_edges";

/** Run a read-only SQL query against ClickHouse's HTTP interface, get back parsed JSON rows. */
async function chQuery(sql) {
  const url = `${CLICKHOUSE_HTTP_URL}/?database=${encodeURIComponent(CLICKHOUSE_DATABASE)}&default_format=JSON`;
  const res = await fetch(url, { method: "POST", body: sql });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`ClickHouse query failed (${res.status}): ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  return json.data ?? [];
}

/** Single quotes are the only injection vector we accept as input (protocol names) — escape them. */
function sqlString(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

// ─── GET /health ────────────────────────────────────────────────────────────────────────────
// Sink status, last indexed block, row count. Cheap enough to poll.
async function handleHealth(res) {
  try {
    const [{ row_count: rowCount, max_block: maxBlock } = {}] = await chQuery(
      `SELECT count() AS row_count, max(block_num) AS max_block FROM ${TABLE}`
    );
    const cursors = await chQuery(`SELECT id, block_num, block_id FROM cursors`).catch(() => []);
    sendJson(res, 200, {
      status: "ok",
      sink: "clickhouse",
      table: TABLE,
      rowCount: Number(rowCount ?? 0),
      lastIndexedBlock: maxBlock != null ? Number(maxBlock) : null,
      cursors: cursors.map((c) => ({ moduleHash: c.id, blockNum: Number(c.block_num), blockId: c.block_id })),
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    sendJson(res, 503, { status: "error", message: String(err.message ?? err) });
  }
}

/**
 * One ClickHouse row -> the trust-graph v0.2.0 wire shape
 * (docs/17-trust-graph-standard.md §4.1). Every endpoint below returns THIS shape, whichever
 * protocol or chain the row came from — that identical-shape property is the standard's whole
 * point, so it is expressed once here rather than re-spelled per endpoint.
 */
function toStandardEdge(r) {
  return {
    protocol: r.protocol,
    network: r.network,
    // "" for protocols with no scope dimension (VouchMe); EAS puts its schemaUID here.
    scope: r.scope ?? "",
    from: r.from_addr, // the ASSERTER
    to: r.to_addr, // the SUBJECT
    kind: r.kind,
    weightRaw: r.weight_raw,
    issuedAt: r.issued_at,
    // `expiresAt` of 1970-01-01 is the standard's PERPETUAL sentinel, not "expired" — see
    // docs/17 §5.2. Surfaced as an explicit boolean so an HTTP consumer cannot misread the date.
    expiresAt: r.expires_at,
    perpetual: r.expires_at === "1970-01-01 00:00:00",
    revoked: Number(r.revoked) === 1,
    blockNum: Number(r.block_num),
    txHash: r.tx_hash,
  };
}

// ─── GET /cross-protocol?address=0x… ────────────────────────────────────────────────────────
// The standard's payoff as an HTTP call: every trust edge touching one address, across EVERY
// indexed protocol and chain, in one identical shape. This is the query that would otherwise be
// N bespoke integrations — note that the SQL below names no protocol and no chain.
//
// `direction` filters to inbound (edges ABOUT this address) or outbound (edges it ASSERTED);
// default is both. `liveOnly=true` applies docs/17 §5.2's liveness predicate verbatim, including
// the perpetual-sentinel arm without which every EAS edge looks expired.
async function handleCrossProtocol(res, query) {
  const address = (query.get("address") ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(address)) {
    return sendJson(res, 400, { error: "address query param must be a 0x-prefixed 20-byte hex address" });
  }
  const direction = query.get("direction") ?? "both";
  if (!["inbound", "outbound", "both"].includes(direction)) {
    return sendJson(res, 400, { error: "direction must be one of: inbound, outbound, both" });
  }
  const liveOnly = query.get("liveOnly") === "true";

  const match =
    direction === "inbound"
      ? `to_addr = ${sqlString(address)}`
      : direction === "outbound"
        ? `from_addr = ${sqlString(address)}`
        : `(to_addr = ${sqlString(address)} OR from_addr = ${sqlString(address)})`;
  const live = liveOnly ? `AND revoked = 0 AND (expires_at = toDateTime(0) OR expires_at > now())` : "";

  try {
    const rows = await chQuery(`
      SELECT protocol, network, scope, from_addr, to_addr, kind, weight_raw,
             issued_at, expires_at, revoked, block_num, tx_hash
      FROM ${TABLE} FINAL
      WHERE ${match} ${live}
      ORDER BY protocol, network, block_num
      LIMIT 1000
    `);
    const edges = rows.map(toStandardEdge);
    const byProtocol = {};
    for (const e of edges) {
      const key = `${e.protocol}:${e.network}`;
      byProtocol[key] ??= { protocol: e.protocol, network: e.network, inbound: 0, outbound: 0 };
      if (e.to === address) byProtocol[key].inbound += 1;
      if (e.from === address) byProtocol[key].outbound += 1;
    }
    sendJson(res, 200, {
      address,
      direction,
      liveOnly,
      schema: "trust-graph v0.2.0",
      count: edges.length,
      byProtocol: Object.values(byProtocol),
      edges,
      note:
        "One query, every indexed protocol and chain. Edges from protocols other than the one " +
        "you are scoring are CONTEXT — this endpoint does not weight or combine them.",
    });
  } catch (err) {
    sendJson(res, 503, { error: String(err.message ?? err) });
  }
}

// ─── GET /edges?protocol=vouchme ───────────────────────────────────────────────────────────────
// The trust edges in the standardized shape. `protocol` is required — this table is
// cross-protocol by design (docs/14-substreams.md §2), and returning every protocol's edges
// unfiltered is never the right default for a caller building one protocol's graph.
async function handleEdges(res, query) {
  const protocol = query.get("protocol");
  if (!protocol) {
    return sendJson(res, 400, { error: "protocol query param is required, e.g. /edges?protocol=vouchme" });
  }
  const limit = Math.min(Number(query.get("limit") ?? 500) || 500, 5000);
  try {
    const rows = await chQuery(`
      SELECT protocol, network, scope, from_addr, to_addr, kind, weight_raw,
             issued_at, expires_at, revoked, block_num, tx_hash
      FROM ${TABLE} FINAL
      WHERE protocol = ${sqlString(protocol)}
      ORDER BY to_addr, from_addr
      LIMIT ${limit}
    `);
    sendJson(res, 200, {
      protocol,
      count: rows.length,
      edges: rows.map(toStandardEdge),
    });
  } catch (err) {
    sendJson(res, 503, { error: String(err.message ?? err) });
  }
}

// ─── GET /stats ─────────────────────────────────────────────────────────────────────────────
// Per-protocol edge/account counts for a dashboard panel.
async function handleStats(res) {
  try {
    // Two queries, merged in JS, rather than one clever-but-wrong SQL expression: a first attempt
    // computed distinct-address count as `uniqExact(to_addr) + uniqExact(from_addr) -
    // uniqExact(if(from_addr = to_addr, from_addr, ''))`, meant to subtract the overlap between
    // the two address sets. It undercounted (3, not the correct 4) on the very first real dataset
    // this served — the `if(...)` `else` branch produces `''` for every non-matching row, and
    // `uniqExact('')` still counts as 1 even when zero rows actually overlap, so the subtraction
    // removes one address that was never double-counted. Found by actually checking the output
    // against known real data (§ see PROOF.md), not by inspection. A real `UNION ALL` of the two
    // address columns computes the true union with no such off-by-one.
    const [counts, addrs] = await Promise.all([
      chQuery(`
        SELECT protocol, count() AS edge_count, countIf(revoked = 0) AS active_edge_count,
               max(block_num) AS last_block
        FROM ${TABLE} FINAL
        GROUP BY protocol
        ORDER BY protocol
      `),
      chQuery(`
        SELECT protocol, uniqExact(addr) AS distinct_addr_count
        FROM (
          SELECT protocol, from_addr AS addr FROM ${TABLE} FINAL
          UNION ALL
          SELECT protocol, to_addr AS addr FROM ${TABLE} FINAL
        )
        GROUP BY protocol
      `),
    ]);
    const addrByProtocol = new Map(addrs.map((a) => [a.protocol, Number(a.distinct_addr_count)]));
    sendJson(res, 200, {
      protocols: counts.map((r) => ({
        protocol: r.protocol,
        edgeCount: Number(r.edge_count),
        activeEdgeCount: Number(r.active_edge_count),
        distinctAddresses: addrByProtocol.get(r.protocol) ?? null,
        lastBlock: Number(r.last_block),
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    sendJson(res, 503, { error: String(err.message ?? err) });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  if (req.method !== "GET") {
    return sendJson(res, 405, { error: "only GET is supported — this is a read-only surface" });
  }
  switch (url.pathname) {
    case "/health":
      return handleHealth(res);
    case "/edges":
      return handleEdges(res, url.searchParams);
    case "/cross-protocol":
      return handleCrossProtocol(res, url.searchParams);
    case "/stats":
      return handleStats(res);
    default:
      return sendJson(res, 404, {
        error: "not found",
        endpoints: [
          "/health",
          "/edges?protocol=<slug>",
          "/cross-protocol?address=0x…[&direction=inbound|outbound|both][&liveOnly=true]",
          "/stats",
        ],
      });
  }
});

server.listen(PORT, () => {
  console.log(`vouchme-substreams read service listening on http://localhost:${PORT}`);
  console.log(`  GET /health`);
  console.log(`  GET /edges?protocol=vouchme`);
  console.log(`  GET /stats`);
  console.log(`ClickHouse HTTP interface: ${CLICKHOUSE_HTTP_URL} (database=${CLICKHOUSE_DATABASE})`);
});
