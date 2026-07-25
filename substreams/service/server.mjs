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

// ─── GET /edges?protocol=aval ───────────────────────────────────────────────────────────────
// The trust edges in the standardized shape. `protocol` is required — this table is
// cross-protocol by design (docs/14-substreams.md §2), and returning every protocol's edges
// unfiltered is never the right default for a caller building one protocol's graph.
async function handleEdges(res, query) {
  const protocol = query.get("protocol");
  if (!protocol) {
    return sendJson(res, 400, { error: "protocol query param is required, e.g. /edges?protocol=aval" });
  }
  const limit = Math.min(Number(query.get("limit") ?? 500) || 500, 5000);
  try {
    const rows = await chQuery(`
      SELECT protocol, network, from_addr, to_addr, kind, weight_raw,
             issued_at, expires_at, revoked, block_num, tx_hash
      FROM ${TABLE} FINAL
      WHERE protocol = ${sqlString(protocol)}
      ORDER BY to_addr, from_addr
      LIMIT ${limit}
    `);
    sendJson(res, 200, {
      protocol,
      count: rows.length,
      edges: rows.map((r) => ({
        protocol: r.protocol,
        network: r.network,
        from: r.from_addr,
        to: r.to_addr,
        kind: r.kind,
        weightRaw: r.weight_raw,
        issuedAt: r.issued_at,
        expiresAt: r.expires_at,
        revoked: Number(r.revoked) === 1,
        blockNum: Number(r.block_num),
        txHash: r.tx_hash,
      })),
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
    case "/stats":
      return handleStats(res);
    default:
      return sendJson(res, 404, {
        error: "not found",
        endpoints: ["/health", "/edges?protocol=<slug>", "/stats"],
      });
  }
});

server.listen(PORT, () => {
  console.log(`aval-substreams read service listening on http://localhost:${PORT}`);
  console.log(`  GET /health`);
  console.log(`  GET /edges?protocol=aval`);
  console.log(`  GET /stats`);
  console.log(`ClickHouse HTTP interface: ${CLICKHOUSE_HTTP_URL} (database=${CLICKHOUSE_DATABASE})`);
});
