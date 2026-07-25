# substreams/ — Aval trust-graph pipeline

One composable Substreams package (`aval-trust/`), a real local sink, and a small read-only HTTP
service — the one documented surface `app/` should call. See `PROOF.md` for the full evidence
trail (every command below, actually run, with real output) and `aval-trust/README.md` for the
package's own module reference.

## The 4801 finding (read this first)

**World Chain Sepolia (chainId 4801) has no Substreams/Firehose endpoint, from any provider, as of
2026-07-25.** Verified independently multiple ways (`PROOF.md` §2, §7.1):

- The Graph's own network registry lists only `worldchain` (World Chain **mainnet**) — no
  `worldchain-sepolia` entry.
- `substreams tools default-endpoint worldchain-sepolia` — no endpoint found.
- `substreams run -e worldchain-sepolia` fails client-side (`invalid endpoint`, can't even resolve
  a hostname) — a *different* failure mode than `-e worldchain` (mainnet), which resolves and then
  correctly reports `Unauthenticated` once no token is present. That contrast is what proves
  Sepolia's problem is "doesn't exist," not "needs a key."
- **Gnosis has the identical problem.** The task's fallback plan named Gnosis (Circles v2 Hub) as
  the second-best target; with real credentials loaded, `-e gnosis` fails the same
  client-side "unknown alias" way, confirmed three more independent ways
  (`substreams tools default-endpoint gnosis`, three DNS hostname guesses, all negative) —
  see `PROOF.md` §7.1. Gnosis is a real, registered *chain id*, just not a reachable Firehose
  endpoint from any provider checked here.
- **Base does have a real endpoint** (`base-mainnet.streamingfast.io:443`) and was used instead —
  the one substitution actually made, and the only one that could be (`PROOF.md` §7.1–§7.3).

This means: the module and manifest are parameterized to index `AvalRegistry` on World Chain
Sepolia — the params ship as the default in `aval-trust/substreams.yaml` — but nothing can stream
that data live today. The decode logic is proven correct against real captured chain data instead
(`cargo test`, no Substreams auth needed — see below). The full live pipeline (Firehose → sink →
this service) is proven end-to-end on Base, using a different real contract, so that "does this
architecture actually work" and "can we reach 4801" stay two separate, separately-answered
questions rather than one blocked claim.

## Layout

```
substreams/
├── aval-trust/          the composable Substreams package (Rust, manifest, proto, schema, tests)
├── service/              this read-only HTTP API, over the sink database
├── scripts/               fetch-fixtures.mjs — reproduces the real on-chain fixtures used in tests
├── PROOF.md               full evidence trail — every command in this README, run for real
└── README.md              this file
```

## Build & verify the package

```bash
cd substreams/aval-trust
cargo test --release                              # 8/8 — decodes real captured chain data, no auth needed
cargo build --target wasm32-unknown-unknown --release
substreams pack ./substreams.yaml                  # -> aval-trust-graph-v0.2.0.spkg
substreams graph ./substreams.yaml                  # module graph (mermaid)
```

Module graph: `map_trust_events` (params + raw block → `TrustEvents`) → `store_edges` (live edge
state) → `map_edge_deltas` (store deltas → `DatabaseChanges`) → `db_out` (stable sink target name).
Full reference in `aval-trust/README.md`.

## Run it live (once you hold `SUBSTREAMS_API_KEY` / `SUBSTREAMS_API_TOKEN`)

```bash
set -a; . ../../.env; set +a        # never echo these values anywhere
cd substreams/aval-trust

# Base + EAS (real, reachable, proven — PROOF.md §7.2). The default params in substreams.yaml
# target Aval/World-Chain-Sepolia instead; override with -p for a reachable chain, same .spkg:
substreams run ./substreams.yaml map_trust_events -e base \
  -p 'map_trust_events=contract=0x4200000000000000000000000000000000000021&vouch_topic=&revoke_topic=&reaffirm_topic=0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35&report_topic=&report_resolved_topic=&model=ISSUANCE&protocol=eas&network=base' \
  -s <recent_block> -t +100 -o jsonl
```

## Run the sink locally (ClickHouse, real rows — PROOF.md §7.3)

```bash
docker run -d --name aval-substreams-clickhouse -p 127.0.0.1:9000:9000 -p 127.0.0.1:8123:8123 \
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

### `GET /edges?protocol=<slug>` (protocol required, e.g. `aval`, `eas`; optional `limit`, default 500, max 5000)

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

Missing `protocol` → `400 { "error": "protocol query param is required, e.g. /edges?protocol=aval" }`.

### `GET /stats`

Per-protocol edge/account counts, for a dashboard panel.

```json
{
  "protocols": [
    { "protocol": "eas", "edgeCount": 3, "activeEdgeCount": 3, "distinctAddresses": 4, "lastBlock": 49100248 }
  ],
  "generatedAt": "2026-07-25T14:56:40.500Z"
}
```

### Real curl output (this session, against the ClickHouse instance populated in `PROOF.md` §7.3)

All three endpoints above are pasted verbatim from an actual `curl http://localhost:8790/...` run
against the real sink DB — not constructed by hand. Re-run any of them the same way once the
service is started (see `PROOF.md` for the full session log).

## Reusing the same package for another protocol/chain

Change `params.map_trust_events` only — never the Rust, never the manifest's `modules:` — per
`docs/14-substreams.md` §2's "one `.spkg`, every chain" design. `skills/aval-substreams-deploy`
automates exactly this substitution, gated on a real decode preview (`eventsFound > 0`) before it
will deploy anything.
