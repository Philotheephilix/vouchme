# substreams/ — the Trust Graph Standard, and the pipeline that implements it

One composable Substreams package (`vouchme-trust/`), a real local sink, and a small read-only HTTP
service — the one documented surface `app/` should call.

**The standard is specified in [`docs/17-trust-graph-standard.md`](../docs/17-trust-graph-standard.md).**
`PROOF.md` is the evidence trail: every command below, actually run, with real output, plus the
things that do **not** work and their exact errors. `vouchme-trust/README.md` is the package's own
operator guide.

## What this is

Trust and attestation is a protocol category with no standardized schema. VouchMe, EAS and Circles
all express *account A asserts something about account B, at a time, revocably* — and all three
model it differently. This directory authors that missing standard and ships a single, reusable
`.spkg` that implements it.

**Live today: two protocols across five chains, from one binary, with zero Rust differing between
them** — only a `networks:` entry per profile.

| Protocol | Networks | Streams live |
|---|---|---|
| `vouchme` | `worldchain` (World Chain mainnet, chainId 480) | yes — `PROOF.md` §9 |
| `eas` | `base`, `optimism`, `arbitrum`, `mainnet` | yes — `PROOF.md` §10.3 |
| `circles` | `gnosis` | **no — Gnosis has no Firehose endpoint** (§11.4) |

The payoff, in one command:

```bash
./scripts/one-query-demo.sh                  # ONE query, 2 protocols, 5 chains
node scripts/crosscheck-trust-edges.mjs      # verify every row against independent public RPCs
```

## Endpoint availability — verified, not assumed

- **World Chain mainnet works.** `substreams tools default-endpoint worldchain` →
  `mainnet.worldchain.streamingfast.io:443`. VouchMe's contracts moved from Sepolia to mainnet on
  2026-07-25, and that move is exactly what unblocked streaming VouchMe's own data.
- **World Chain Sepolia (4801) has no endpoint, from any provider** — not in The Graph's network
  registry, and `-e worldchain-sepolia` fails client-side as an unresolvable hostname, a
  *different* failure mode from mainnet's `Unauthenticated`-without-a-token. That contrast is what
  proved the problem was "doesn't exist," not "needs a key" (`PROOF.md` §2). Historical now, but it
  is why the earlier proofs had to run on Base.
- **Gnosis has the identical problem**, re-confirmed with credentials loaded:
  `substreams tools default-endpoint gnosis` → `no endpoint found`, plus three NXDOMAIN hostname
  probes (`PROOF.md` §7.1, §11.4). Gnosis is a real registered chain id, just not a reachable
  Firehose endpoint. Circles v2's adapter profile is specified and trivial; it cannot be run.
- **Base, Optimism, Arbitrum and Ethereum mainnet all resolve and stream** (`PROOF.md` §10.3).

## Layout

```
substreams/
├── vouchme-trust/       the composable Substreams package (Rust, manifest, proto, schema, tests)
├── service/             read-only HTTP API over the sink database
├── scripts/
│   ├── one-query-demo.sh             the payoff: ONE query across every indexed protocol/chain
│   ├── crosscheck-trust-edges.mjs    independent audit of every sink row vs. public RPCs
│   ├── verify-mainnet.mjs            plain eth_getLogs ground truth for VouchMe on chain 480
│   └── fetch-fixtures.mjs            reproduces the real on-chain fixtures used in tests
├── PROOF.md             full evidence trail — every command in this README, run for real
└── README.md            this file
```

## Build & verify the package

```bash
cd substreams/vouchme-trust
cargo test                                          # 21/21 — decodes real captured chain data, no auth needed
cargo build --target wasm32-unknown-unknown --release
substreams pack ./substreams.yaml                   # -> vouchme-trust-graph-v0.2.0.spkg
substreams graph ./substreams.yaml                  # module graph (mermaid)
```

Module graph: `map_trust_events` (params + raw block → `TrustEvents`) → `store_edges` (live edge
state) → `map_edge_deltas` (store deltas → `DatabaseChanges`) → `db_out` (stable sink target name).
Full reference in `vouchme-trust/README.md`.

## Run it live

```bash
set -a; . ../../.env; set +a        # never echo these values anywhere
cd substreams/vouchme-trust

# The SAME .spkg on every chain. Only --network and -e change; no params to hand-write, because
# each adapter profile ships in the manifest's `networks:` block.
substreams run ./substreams.yaml map_trust_events --network worldchain -e worldchain -s 32835370  -t +20 -o jsonl
substreams run ./substreams.yaml map_trust_events --network base       -e base       -s 49110120  -t +90 -o jsonl
substreams run ./substreams.yaml map_trust_events --network optimism   -e optimism   -s 154673910 -t +20 -o jsonl
substreams run ./substreams.yaml map_trust_events --network arbitrum   -e arbitrum   -s 487448500 -t +40 -o jsonl
substreams run ./substreams.yaml map_trust_events --network mainnet    -e mainnet    -s 25601310  -t +12 -o jsonl
```

## Run the sink locally (ClickHouse, real rows — PROOF.md §7.3)

```bash
docker run -d --name vouchme-substreams-clickhouse -p 127.0.0.1:9000:9000 -p 127.0.0.1:8123:8123 \
  -e CLICKHOUSE_USER=default -e CLICKHOUSE_PASSWORD= -e CLICKHOUSE_DB=default \
  clickhouse/clickhouse-server:24-alpine

DSN="clickhouse://default:@localhost:9000/default"
substreams-sink-sql setup "$DSN" ./substreams.yaml
substreams-sink-sql run   "$DSN" ./substreams.yaml "<start>:<stop>" -e base -p 'map_trust_events=...' \
  --undo-buffer-size=1 --development-mode --batch-block-flush-interval=1
```

`--development-mode` matters for a narrow range: without it the sink schedules parallel workers
sized for a full backfill and can spend its whole run negotiating segments instead of streaming.
`store_edges`/`map_edge_deltas`/`db_out` inherit `initialBlock` from the manifest (`32216305` —
World Chain Sepolia's deployment block) — a store must build state forward from `initialBlock`, so
pointing `params` at a different chain does **not** by itself let the sink cold-start elsewhere on
it; `initialBlock` needs to move too. `map_trust_events` alone (no store) has no such restriction.
See `PROOF.md` §7.3 for the exact temporary manifest edit used to prove this on Base, and why it
was reverted afterward rather than left in the shipped manifest.

## The HTTP service

One process, zero framework dependencies, reads ClickHouse's HTTP interface (default port 8123).

**Start it:**

```bash
node substreams/service/server.mjs
# optional: PORT=8790 CLICKHOUSE_HTTP_URL=http://localhost:8123 CLICKHOUSE_DATABASE=default
```

Binds **port 8790** (3000 and 8788 are taken elsewhere in this repo; 8790+ is clear).

### `GET /health`

Sink status, last indexed block, row count.

```json
{
  "status": "ok",
  "sink": "clickhouse",
  "table": "trust_edges",
  "rowCount": 3,
  "lastIndexedBlock": 49100248,
  "cursors": [
    { "moduleHash": "f72752222ab2f937f6424379a4afa835b2e9a886", "blockNum": 49100260, "blockId": "c67312af..." }
  ],
  "checkedAt": "2026-07-25T14:56:40.456Z"
}
```

### `GET /edges?protocol=<slug>` (protocol required, e.g. `vouchme`, `eas`; optional `limit`, default 500, max 5000)

The trust edges in the standardized shape, deduplicated to current state (`FINAL`), ordered by
`(to, from)` — the engine's hot access pattern (docs/14-substreams.md §4).

```json
{
  "protocol": "eas",
  "count": 3,
  "edges": [
    {
      "protocol": "eas", "network": "base",
      "from": "0x2103a27f51066c7a6cecf1fc1048a06740a22571",
      "to": "0x357458739f90461b99789350868cd7cf330dd7ee",
      "kind": "REAFFIRM", "weightRaw": "0",
      "issuedAt": "2026-07-25 14:29:09", "expiresAt": "2106-02-07 06:28:15",
      "revoked": false, "blockNum": 49100201,
      "txHash": "0x0e2f6e8e149184b96f5fed79e42a8ac11a5335b5a62f50be112097cffa143771"
    }
  ]
}
```

**`issuedAt`** is always the real time the event happened — the decoded ABI word when the event
carries one, the containing block's own timestamp otherwise. It is never Unix epoch (`1970-01-01`)
— a build earlier in this session had that defect (found by a reviewer querying ClickHouse
directly, not via this endpoint); see `PROOF.md` §8 for the two-layer root cause and the fix.

**`expiresAt` = `2106-02-07 06:28:15`** (`4294967295`) is a **clamp-safety ceiling**, not a "never
expires" value for any real protocol convention. It shows up specifically for the Base/EAS demo
edges above: EAS's `Attested` event carries a `uid` (content hash) in its one non-indexed word, not
a timestamp — this generic, protocol-agnostic decoder has no way to know that ABI-shape-wise, reads
it as one anyway, and the sink clamps the resulting huge number so it doesn't crash ClickHouse's
`DateTime` column. It is not real expiry data for these three rows — see `PROOF.md` §8.2. Contrast
Circles v2's `Trust.expiryTime`, verified against real Gnosis logs as a genuine timestamp in the
same field position (`PROOF.md` §7.1) — that mapping's `expiresAt` would be meaningful.

Missing `protocol` → `400 { "error": "protocol query param is required, e.g. /edges?protocol=vouchme" }`.

### `GET /cross-protocol?address=0x…[&direction=inbound|outbound|both][&liveOnly=true]`

**The standard's payoff as an HTTP call.** Every trust edge touching one address, across every
indexed protocol and chain, in one identical shape. The SQL behind it names no protocol and no
chain — this is the query that would otherwise be N bespoke integrations.

`liveOnly=true` applies the standard's liveness predicate verbatim
(`docs/17-trust-graph-standard.md` §5.2), including the perpetual-sentinel arm without which every
EAS edge looks expired. Each edge also carries an explicit `perpetual` boolean so an HTTP consumer
cannot misread `1970-01-01` as "long expired".

```json
{
  "address": "0x70d9e7a9dabf66d7bae8b7656e2a838b26707fe8",
  "schema": "trust-graph v0.2.0",
  "count": 1,
  "byProtocol": [{ "protocol": "eas", "network": "base", "inbound": 1, "outbound": 0 }],
  "edges": [
    {
      "protocol": "eas", "network": "base",
      "scope": "0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4",
      "from": "0x357458739f90461b99789350868cd7cf330dd7ee",
      "to": "0x70d9e7a9dabf66d7bae8b7656e2a838b26707fe8",
      "kind": "VOUCH", "weightRaw": "1",
      "issuedAt": "2026-07-25 20:00:09", "expiresAt": "1970-01-01 00:00:00", "perpetual": true,
      "revoked": false, "blockNum": 49110131,
      "txHash": "0xacb7dc06ef040ad1c4463f2a974a7d60894f3f36928c13b76dd5df9f773a447e"
    }
  ]
}
```

This is the endpoint `@vouchme/mcp`'s `vouchme_cross_protocol_trust` tool consumes — the MCP layer over
the standardized store.

### `GET /stats`

Per-protocol edge/account counts, for a dashboard panel.

```json
{
  "protocols": [
    { "protocol": "vouchme", "edgeCount": 1, "activeEdgeCount": 1, "distinctAddresses": 2, "lastBlock": 32835377 },
    { "protocol": "eas", "edgeCount": 9, "activeEdgeCount": 5, "distinctAddresses": 12, "lastBlock": 487448518 }
  ],
  "generatedAt": "2026-07-25T20:17:40.369Z"
}
```

### Real curl output

Every endpoint above is pasted verbatim from an actual `curl http://localhost:8790/...` run
against the real sink DB — not constructed by hand. Re-run any of them the same way once the
service is started (see `PROOF.md` for the full session log).

## Reusing the same package for another protocol/chain

Change `params.map_trust_events` only — never the Rust, never the manifest's `modules:` — per
`docs/14-substreams.md` §2's "one `.spkg`, every chain" design. `skills/vouchme-substreams-deploy`
automates exactly this substitution, gated on a real decode preview (`eventsFound > 0`) before it
will deploy anything.
