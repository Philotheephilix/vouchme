# Best Use of Composable or Standardized Graph Products

**VouchMe — the Trust Graph Standard v0.2.0, and the composable Substreams module that implements it.**

Spec: [`docs/17-trust-graph-standard.md`](../docs/17-trust-graph-standard.md) ·
Module: [`substreams/vouchme-trust/`](../substreams/vouchme-trust/) ·
Evidence: [`substreams/PROOF.md`](../substreams/PROOF.md) §9–§12

---

## 0. The one-paragraph version

Trust and attestation is a protocol *category* with no standardized schema. VouchMe, EAS and Circles
all express the same primitive — *account A asserts something about account B, at a time,
revocably* — and each models it differently. We authored a Standardized Subgraph schema for that
category and shipped its executable form: **one Substreams `.spkg` that indexes two protocols
across five chains with zero per-protocol Rust**, sinking into one `trust_edges` table via
`substreams-sink-sql`, read by one MCP tool that contains no per-protocol branching. Adding EAS
across four chains cost **four `networks:` entries and one imported `.spkg`** — no new modules, no
recompile. The second protocol also broke the standard in three specific ways, which is the part
worth reading: §4.

**One query, everything, naming no protocol and no chain** — run by us just now against the live
ClickHouse sink:

```
protocol  network      edges  attesters
vouchme      worldchain       1          1
eas       arbitrum         1          1
eas       base             5          2
eas       mainnet          1          1
eas       optimism         2          1
```

Every one of those 10 rows is independently re-derived from public JSON-RPC —
**`10 verified, 0 failed`** (§6).

---

## 1. The qualification gates, answered directly

| # | Gate | Answer | Where |
|---|---|---|---|
| 1 | Compose **two or more** Graph products, **or** build meaningfully on a standardized schema | **Both.** Six composed products (§5); and the standardized schema is one we authored for a category that lacked one | §5, §3 |
| 2 | **Consume live data from a Graph provider. Mocked/static does not qualify** | Live Firehose/Substreams streams on 5 endpoints, re-run during the writing of this document — 20 blocks / 7.7 KiB on World Chain, 90 blocks / 35 KiB on Base, both `Completed successfully` | §5.1 |
| 3 | Querying **one** Subgraph with no composition does **not** qualify | We query no Subgraph at all. The surface is a standardized multi-protocol Substreams package + SQL sink. Our own VouchMe subgraph exists and is **explicitly excluded** — it is undeployed and single-protocol | §7.2 |
| 4 | Authoring/extending a Standardized Subgraph, or contributing a reusable composable Substreams module | Both: a new standard (`docs/17-trust-graph-standard.md`) **and** a reusable `.spkg` whose modules are importable — already imported by a second manifest in this repo | §3, §5.4 |
| 5 | Make the standards leverage clear | §6 — the counterfactual, stated as a number |

---

## 2. The gap being filled

DEXes have a standardized schema. Lending has one. **Trust and attestation does not** — and it is
a category, not a protocol. Every member expresses the same primitive and none of them agree on
how:

| Protocol | Its vocabulary | Its event shape |
|---|---|---|
| VouchMe | `Vouched` / `Reaffirmed` / `Revoked` | `(address indexed voucher, address indexed vouchee, uint64 issuedAt, uint64 expiresAt)` |
| EAS | `Attested` / `Revoked` | `(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)` |
| Circles v2 | `Trust` | `(address indexed truster, address indexed trustee, uint256 expiryTime)` |

They disagree on the name of the relation, **on the order of the indexed params**, on whether
expiry exists, on whether an assertion is scoped, and on what a weight is. A product that wants to
answer *"who vouches for this account, anywhere?"* today writes N integrations, N schemas, N sets
of query logic — and gets N chances to reverse an edge.

This is why the submission is *"a new Standardized Subgraph for a protocol category that lacks
one"* rather than a retrofit of an existing standard.

---

## 3. The standard

### 3.1 Fields — `TrustEvent` (`proto/trust_graph.proto`, package `vouchme.trust.v1`)

| Field | Type | Meaning |
|---|---|---|
| `protocol` | `string` | Stable slug: `vouchme`, `eas`, `circles` |
| `network` | `string` | Chain slug **matching The Graph's network registry** — `worldchain`, `base`, `optimism`, `arbitrum`, `mainnet` |
| `kind` | enum | `VOUCH` / `REVOKE` / `REAFFIRM` / `REPORT` / `REPORT_RESOLVED` |
| `from` | `bytes` | **The asserter** |
| `to` | `bytes` | **The subject** |
| `scope` | `string` | Protocol-native discriminator (EAS: `schemaUID`); `""` when the protocol has none |
| `weight_raw` | `string` | Protocol-native, **unnormalized** — normalization is the consumer's job |
| `issued_at` | `uint64` | Unix seconds. **Never 0** |
| `expires_at` | `uint64` | Unix seconds; **`0` = perpetual**, not expired |
| `tx_hash`, `block_num` | | Provenance |

Two semantics carry their weight in the negative space:

- **`expires_at = 0` is the perpetual sentinel.** It renders as `1970-01-01 00:00:00`. Every
  consumer must use the liveness predicate
  `revoked = 0 AND (expires_at = toDateTime(0) OR expires_at > now())`. A bare `expires_at > now()`
  marks **every** EAS edge dead. The predicate ships in `schema.sql`'s comments and is used
  verbatim by the demo script and the MCP service.
- **Absent data is declared, never inferred.** EAS's real `expirationTime` lives in contract
  storage, not the log. The standard says so rather than guessing — §4.2 is the bug that rule was
  written in response to.

### 3.2 Edge identity — the five-part key

```
(protocol, network, scope, to, from)
```

Enforced identically in three places, and asserted to match: `edge_key()` (`src/lib.rs:440`), the
CDC key in `map_edge_deltas`, and `ORDER BY` on the `ReplacingMergeTree` in `schema.sql:96`.
**`network` and `scope` are the two parts a single-protocol schema never discovers** — see §4.3.

### 3.3 The adapter-profile mechanism — a protocol joins declaratively

A protocol joins the standard by declaring a profile: a query-string in the manifest's `networks:`
block. No Rust, no module-graph change, same binary.

| Param | Meaning |
|---|---|
| `contract` | Address to index |
| `protocol`, `network` | Provenance slugs written onto every edge |
| `<kind>_topic` | `topic0` → `Kind` dispatch; empty = protocol has no such event |
| `from_topic` / `to_topic` | 1-based topic index carrying the **asserter** / the **subject** |
| `scope_topic` | Topic index carrying the scope discriminator; empty = none |
| `<kind>_tail` | Non-indexed tail layout: `issued_expires` \| `expires` \| `at` \| **`none`** |
| `model` | Advisory tag: `WEIGHTED` \| `BINARY` \| `ISSUANCE` |

Two deliberate strictnesses, both because the failure mode is *plausible-looking wrong data* rather
than a crash: an unrecognized `<kind>_tail` is a **fatal** parse error (a typo like
`vouch_tail=nil` would otherwise resurrect §4.2), and `from_topic == to_topic` or either `== 0`
(topic0 is the event signature) is a **fatal** parse error.

The five registered profiles, verbatim from `substreams.yaml`:

| Protocol | Network | Contract | Roles | Scope | Tails |
|---|---|---|---|---|---|
| `vouchme` | `worldchain` | `0x6fEfEf2d…8722` | `from=1, to=2` | — | `vouch=issued_expires`, `revoke=at`, `reaffirm=expires` |
| `eas` | `base` | `0x4200…0021` | **`from=2, to=1`** | `3` | `vouch=none`, `revoke=none` |
| `eas` | `optimism` | `0x4200…0021` | **`from=2, to=1`** | `3` | `vouch=none`, `revoke=none` |
| `eas` | `arbitrum` | `0xbD75f629…c458` | **`from=2, to=1`** | `3` | `vouch=none`, `revoke=none` |
| `eas` | `mainnet` | `0xA1207F3B…E587` | **`from=2, to=1`** | `3` | `vouch=none`, `revoke=none` |

Note that EAS on Arbitrum is *not* a predeploy — a different address from the OP-stack chains.
Same profile shape regardless, which is the point.

---

## 4. Three defects the second protocol exposed

This is the most credible section, because it is evidence the standard was **exercised**, not just
written. All three were invisible with one protocol indexed, and all three produce output that
looks completely fine.

### 4.1 Every EAS edge pointed backwards

EAS declares **subject first**:

```solidity
event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID);
```

VouchMe declares **asserter first** (`Vouched(voucher, vouchee, …)`). v0.1.0 hardcoded
`from = topics[1]`, so every EAS edge recorded the person being attested *about* as the one doing
the attesting. The rows that were in ClickHouse (PROOF.md §10.1) put
`0x357458739f90461b99789350868cd7cf330dd7ee` — a prolific Base **attester**, present as `topics[2]`
in dozens of live logs — in the `to` column.

Nothing about the output looked wrong. Two real addresses, a real tx hash, a real block. There is
no ABI-level signal distinguishing the two orderings; both decode cleanly and only one is right.
Hence the standard's design rule: **direction is data, not convention** — declared per deployment,
never inferred.

**Pinned by** `v0_1_0_topic_order_would_reverse_this_eas_edge` (`src/lib.rs:1150`). It feeds a real
Base log through v0.1.0-style params and *asserts the wrong answer*, so the bug cannot come back
silently. **Independently** re-checked by `crosscheck-trust-edges.mjs:164-171`, which tests for this
case specifically and reports `edge is REVERSED vs the on-chain log` by name rather than a generic
miss.

### 4.2 A content hash decoded as a clock, fabricating `expires_at = 2106-02-07`

An EAS log's only non-indexed word is the attestation `uid` — a content hash. Under v0.1.0 the tail
layout was *inferred from the kind* ("a VOUCH has two uint64 words, a REVOKE has one"). Applied to
EAS, that read the hash as a timestamp. The resulting `u64` was large enough that `u64 as i64`
wrapped negative (`-475969128228036841`) and ClickHouse rejected the whole flush batch; a clamp into
`DateTime`'s valid range stopped the crash and produced `expires_at = 2106-02-07 06:28:15` on live
rows — **a fabricated value that read as a deliberate "never expires" convention.**

v0.2.0 replaces the inference with a **declared** `TailLayout`, of which `none` is a first-class
answer. EAS declares `vouch_tail=none` / `revoke_tail=none`: `issued_at` becomes the block clock,
`expires_at` becomes `0`, the perpetual sentinel. The standard now records *"this log proves no
expiry"* instead of inventing one.

**Pinned by** `parse_params_rejects_an_unknown_tail_layout` (`src/lib.rs:1234`) — a typo
`vouch_tail=nil` is a fatal error, not a silent fallback to the guessing path — and by
`decodes_a_real_eas_revoked_log_as_revoke` (`src/lib.rs:1178`), which asserts on a real Base log
that `issued_at == 1_785_003_890` (the block clock) and `expires_at == 0`.

### 4.3 An edge key that collided the same protocol on different chains

The v0.1.0 key was `(protocol, to, from)`. That is wrong in two independent ways the moment one
schema holds more than one thing:

- **`network`** — addresses are not chain-scoped. `eas` on Base and `eas` on Optimism share the
  `protocol` slug, so an edge on one chain silently overwrote the identically-addressed edge on the
  other. ClickHouse's `ReplacingMergeTree` deduped them into one row.
- **`scope`** — one EAS attester routinely holds several live attestations about the *same*
  recipient under different `schemaUID`s. Without `scope` in the key, revoking one marked all of
  them revoked.

Both are visible in today's live output: **rows 5 and 6** of §6's table are the same
`(from, to)` pair on the same chain, kept apart **only** by `scope`.

**Pinned by** `scope_keeps_same_pair_different_schema_edges_distinct` (`src/lib.rs:1210`), which
asserts both arms — different `schemaUID` ⇒ different key, and *same protocol + same pair on
another chain* ⇒ different key. `sink_profiles_match_the_streaming_manifest` additionally fails the
build if the two manifests' profiles drift.

> Neither the unit tests nor the SQL sink could have caught §4.1 on their own. It took a second
> protocol with an opposite convention, and then an auditor that re-derives the edge from the raw
> log without parsing our manifest.

---

## 5. Which Graph products are composed, and the evidence each is live

| # | Product | How it is used | Live evidence |
|---|---|---|---|
| 1 | **Substreams / Firehose** (StreamingFast, The Graph) | The extractor itself — `map_trust_events`, `store_edges`, `map_edge_deltas`, `db_out` | 5 authenticated endpoints; two re-run below |
| 2 | **The Graph network registry** | Endpoint resolution *and* the standard's `network` slug vocabulary | `substreams tools default-endpoint worldchain` → `mainnet.worldchain.streamingfast.io:443` |
| 3 | **`substreams-sink-database-changes` v4.0.0** (imported `.spkg`) | Supplies `sf.substreams.sink.database.v1.DatabaseChanges` — the **output type of two of our four modules** | `substreams.yaml:21`; `substreams info` reports both modules with that output type |
| 4 | **`substreams-sink-sql` v4.13.1** → ClickHouse | Materializes the standard's relational form into `trust_edges` | Real table, 10 rows, container `vouchme-substreams-clickhouse` |
| 5 | **`substreams-sink-sql` protodefs v1.0.7** (imported `.spkg`) | Supplies `sf.substreams.sink.sql.v1.Service` to the sink manifest | `substreams.sink.yaml:39` |
| 6 | **Our own `.spkg`, imported as a dependency** | `substreams.sink.yaml` imports `main: ./vouchme-trust-graph-v0.2.0.spkg` and declares **no modules of its own** — modules referenced as `main:db_out` | This is the reuse pattern of §3.3, demonstrated inside the repo |

Consumed on top: an **MCP tool** (`mcp/src/tools/vouchme_cross_protocol_trust.ts`) that queries the
standardized store, and a dependency-free HTTP service (`substreams/service/server.mjs`) over
`trust_edges`.

### 5.1 Live streams, re-run while writing this document

Same `.spkg`, `sha256 81309a936912b2920b994e4dbbcc644117a8ab4ca0578b34e836560e9fe1db78` (477,731
bytes). **Only `--network` differs.** No recompile between these two commands.

```
$ substreams run ./substreams.yaml map_trust_events --network worldchain -e worldchain -s 32835370 -t +20 -o jsonl
{"@module":"map_trust_events","@block":32835377,"@type":"vouchme.trust.v1.TrustEvents","@data":{"events":[
  {"protocol":"vouchme","network":"worldchain",
   "from":"0xb23a3b2384d721d7c487a3acc6405a1d36672b47",
   "to":"0x4774b9621102eac2254365f9311c4e7700d9e7de",
   "weightRaw":"1","issuedAt":"1785006393","expiresAt":"1792782393",
   "txHash":"0x563172cb968bb63b2ba362fa95d6ff257bf94554076ebbbb39e3969cab3d5c45",
   "blockNum":"32835377"}]}}
📊 Usage Report • Egress Bytes (uncompressed): 7.7 KiB • Processed Blocks: 20 • Received Blocks: 20
Completed successfully
```

```
$ substreams run ./substreams.yaml map_trust_events --network base -e base -s 49110120 -t +90 -o jsonl
{"@block":49110131,"events":[
  {"protocol":"eas","network":"base","from":"0x561143bfe9e2d975d92e915b8effeaa54119472a",
   "to":"0x0000000000000000000000000000000000000000","issuedAt":"1785009609",
   "scope":"0xe74a27f6c216134a1a3aef4c26e29bd8866ac679a8023ddde34faa0bb05dd272", …},
  {"protocol":"eas","network":"base","from":"0x357458739f90461b99789350868cd7cf330dd7ee",
   "to":"0x70d9e7a9dabf66d7bae8b7656e2a838b26707fe8","issuedAt":"1785009609",
   "scope":"0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4", …}]}
{"@block":49110196,"events":[{"kind":"REVOKE","from":"0x357458739f90461b99789350868cd7cf330dd7ee", …}]}
{"@block":49110201,"events":[{"kind":"REVOKE", …}]}
{"@block":49110204,"events":[{"kind":"REVOKE", …}]}
📊 Usage Report • Egress Bytes (uncompressed): 35 KiB • Processed Blocks: 90 • Received Blocks: 90
Completed successfully
```

`from` is the **attester** in every EAS row. Compare against §4.1.

**Two data planes agree byte-for-byte.** `node substreams/scripts/verify-mainnet.mjs` reads the same
VouchMe contract over plain JSON-RPC via Alchemy — a different provider, a different protocol, no
StreamingFast credential — across the contract's whole deployed lifetime (5,036 blocks at time of
writing):

```
counts (topic0-filtered, whole deployed lifetime):  Enrolled 2 · Vouched 1 · Reaffirmed 0 · Revoked 0

{"event":"Vouched","blockNum":32835377,
 "txHash":"0x563172cb968bb63b2ba362fa95d6ff257bf94554076ebbbb39e3969cab3d5c45",
 "from":"0xb23a3b2384d721d7c487a3acc6405a1d36672b47",
 "to":"0x4774b9621102eac2254365f9311c4e7700d9e7de",
 "issuedAt":1785006393,"expiresAt":1792782393,"expiryDays":90}
```

Identical `from`, `to`, `issuedAt`, `expiresAt`, `txHash` and `blockNum` to the Firehose output
above. The 90-day expiry falls out of subtracting the two decoded words
(`1792782393 - 1785006393 = 7776000 = 90 × 86400`); it is asserted nowhere in the module.
`Enrolled` is deliberately absent from the standardized output — it is account context, not an
assertion between two parties, so it has no `Kind` in `trust_graph.proto` and the module skips it.

Toolchain, as verified on this box: `substreams 1.20.2 (Commit 4873219)`,
`substreams-sink-sql 4.13.1 (Commit c05b15e)`. `substreams info` on the packed `.spkg` reports four
modules, `Networks: optimism, arbitrum, mainnet, worldchain, base`, and
`Sink config: type sf.substreams.sink.sql.v1.Service … engine: 2`, with `schema.sql` embedded
(7,417 bytes, MD5 `2a4a2c5a619c2fefc32c84da74e650f9` — matches the working-tree file exactly).

### 5.2 The consumer: one MCP tool, no per-protocol branching

`vouchme_cross_protocol_trust` makes **one** request against the standardized store and returns
whatever protocols happen to be registered. Three live calls, three different protocol/chain
combinations, one output shape, one code path:

```
0x4774b9621102eac2254365f9311c4e7700d9e7de → byProtocol: [{ vouchme,     worldchain, inbound: 1 }]
0x70d9e7a9dabf66d7bae8b7656e2a838b26707fe8 → byProtocol: [{ eas,      base,       inbound: 1 }]
0xfc61965861b679c5aa728d41fa6ea0b29544f554 → byProtocol: [{ eas,      optimism,   inbound: 1 }]
```

Every edge carries `"schema": "trust-graph v0.2.0"` and a `perpetual` boolean derived from the
sentinel. **The absence of branching is the deliverable** — registering Circles changes neither
this file nor its configuration.

One honest detail visible in that output: the tool also returns
`"unavailable": ["VouchMe engine enrichment skipped (timed out after 8000ms) — VouchMe edges below come
from the standardized store and carry no vouchMeWeight"]`. That enrichment is a *bespoke,
single-protocol* `eth_getLogs` replay — the exact thing the standard exists to replace. It is
bounded by a deadline rather than awaited; when it times out, **the VouchMe edge is still returned,
correct and complete, from the standardized store**, and only the normalized `vouchMeWeight` is lost.
The tool names what it lost instead of returning an empty result. A bespoke integration degraded and
the shared schema covered for it.

---

## 6. The leverage, concretely

> **Adding EAS across four chains cost zero lines of Rust and zero new modules.**
> The delta was **four `networks:` entries** in the manifest plus **one imported `.spkg`**.
> The counterfactual — the thing this replaces — is **four bespoke indexers with four schemas**,
> four sets of query logic, and four independent chances to reverse an edge (§4.1 shows we would
> have taken at least one of them).

What that bought, stated as things that are now true and were not before:

1. **One SQL query spans two protocols on five chains.** The query names no protocol and no chain
   — it does not need to know which exist. No joins, no unions, no per-protocol branches.
2. **The consumer's query does not change when a protocol is added.** Identity (§3.2), liveness
   (§3.1) and provenance are standardized, so a consumer written against `trust_edges` today keeps
   working when Circles lands.
3. **Cross-protocol analysis is a `GROUP BY`.** "Every subject asserted about on any protocol, and
   by whom" is one aggregate over one table — bottom panel below.
4. **The hard questions are localized.** *"Which indexed param is the asserter?"* is asked once per
   protocol, in a reviewable config line with a regression test behind it — instead of being
   re-answered implicitly, and wrongly, in every integration.

### 6.1 `./substreams/scripts/one-query-demo.sh` — real output, run just now

```
────────────────────────────────────────────────────────────────────────────────
 ONE standardized query · 2 protocols · 5 chains · 1 .spkg
 The query below names no protocol and no chain.
────────────────────────────────────────────────────────────────────────────────
┌─protocol─┬─network────┬─kind───┬─from_addr──────────────────────────────────┬─to_addr────────────────────────────────────┬─scope──────┬───────────issued_at─┬──────────expires_at─┬─revoked─┬─block_num─┐
│ vouchme  │ worldchain │ VOUCH  │ 0xb23a3b2384d721d7c487a3acc6405a1d36672b47 │ 0x4774b9621102eac2254365f9311c4e7700d9e7de │            │ 2026-07-25 19:06:33 │ 2026-10-23 19:06:33 │       0 │  32835377 │
│ eas      │ arbitrum   │ VOUCH  │ 0x7848a3578ff2e1f134659a23f64a404a4d710475 │ 0x83143ed768fa64744835ad58748f8dd90ec7a17e │ 0x1f3dce65 │ 2026-07-25 04:24:39 │ 1970-01-01 00:00:00 │       0 │ 487448518 │
│ eas      │ base       │ VOUCH  │ 0x357458739f90461b99789350868cd7cf330dd7ee │ 0x70d9e7a9dabf66d7bae8b7656e2a838b26707fe8 │ 0x254bd1b6 │ 2026-07-25 20:00:09 │ 1970-01-01 00:00:00 │       0 │  49110131 │
│ eas      │ base       │ VOUCH  │ 0x561143bfe9e2d975d92e915b8effeaa54119472a │ 0x0000000000000000000000000000000000000000 │ 0xe74a27f6 │ 2026-07-25 20:00:09 │ 1970-01-01 00:00:00 │       0 │  49110131 │
│ eas      │ base       │ REVOKE │ 0x357458739f90461b99789350868cd7cf330dd7ee │ 0x59fbe10e34aa7639ae3047aeb01ffedee5398ad0 │ 0x1801901f │ 2026-07-25 20:02:19 │ 1970-01-01 00:00:00 │       1 │  49110196 │
│ eas      │ base       │ REVOKE │ 0x357458739f90461b99789350868cd7cf330dd7ee │ 0x59fbe10e34aa7639ae3047aeb01ffedee5398ad0 │ 0xf8b05c79 │ 2026-07-25 20:02:29 │ 1970-01-01 00:00:00 │       1 │  49110201 │
│ eas      │ base       │ REVOKE │ 0x357458739f90461b99789350868cd7cf330dd7ee │ 0x47eb9421160ba1ea20b687500d0da38126963ed0 │ 0x254bd1b6 │ 2026-07-25 20:02:35 │ 1970-01-01 00:00:00 │       1 │  49110204 │
│ eas      │ mainnet    │ VOUCH  │ 0x8f9da3ff538ace863acb9df219b2cd3b4a15ad0e │ 0x0000000000000000000000000000000000000000 │ 0xba93950a │ 2026-07-24 08:11:23 │ 1970-01-01 00:00:00 │       0 │  25601316 │
│ eas      │ optimism   │ REVOKE │ 0x359f56ae92f4c3074e7466ed7693cc4715217f74 │ 0x6923e759519ede7e352b1e206519c28046f0a69f │ 0xcc51e247 │ 2026-07-25 02:30:13 │ 1970-01-01 00:00:00 │       1 │ 154673918 │
│ eas      │ optimism   │ VOUCH  │ 0x359f56ae92f4c3074e7466ed7693cc4715217f74 │ 0xfc61965861b679c5aa728d41fa6ea0b29544f554 │ 0xcc51e247 │ 2026-07-25 02:30:19 │ 1970-01-01 00:00:00 │       0 │ 154673921 │
└──────────┴────────────┴────────┴────────────────────────────────────────────┴────────────────────────────────────────────┴────────────┴─────────────────────┴─────────────────────┴─────────┴───────────┘

── cross-protocol analysis: every subject asserted about, on any protocol ──────
   (uses the standard's liveness predicate — note the perpetual-sentinel arm)
┌─subject────────────────────────────────────┬─live_inbound_edges─┬─asserted_on───────────┐
│ 0x0000000000000000000000000000000000000000 │                  2 │ eas:base, eas:mainnet │
│ 0x4774b9621102eac2254365f9311c4e7700d9e7de │                  1 │ vouchme:worldchain    │
│ 0x70d9e7a9dabf66d7bae8b7656e2a838b26707fe8 │                  1 │ eas:base              │
│ 0x83143ed768fa64744835ad58748f8dd90ec7a17e │                  1 │ eas:arbitrum          │
│ 0xfc61965861b679c5aa728d41fa6ea0b29544f554 │                  1 │ eas:optimism          │
└────────────────────────────────────────────┴────────────────────┴───────────────────────┘
```

Rows 5 and 6 are the same `(from, to)` pair on the same chain, distinguished **only** by `scope` —
§4.3 made concrete. The zero-address subject is real: EAS permits it, and the standard records what
the chain says rather than filtering. Filtering is a consumer policy decision, applied at query time.

### 6.2 The audit — the rows are not taken on trust

`crosscheck-trust-edges.mjs` streams nothing. It reads every row from `trust_edges`, re-fetches
that row's transaction via `eth_getTransactionReceipt` on a **public RPC for that row's own chain**
(a different data plane, no StreamingFast credential), and re-applies the adapter profile to the
raw log using a second implementation that **deliberately does not parse `substreams.yaml`** —
parsing it would make the auditor agree with a bug instead of catching it.

```
$ node substreams/scripts/crosscheck-trust-edges.mjs
crosschecking 10 standardized trust edges against independent RPC reads

OK    vouchme/worldchain 0x563172cb96… blk 32835377
        VOUCH  from=0xb23a3b2384d721d7c487a3acc6405a1d36672b47 to=0x4774b9621102eac2254365f9311c4e7700d9e7de
        issued_at=2026-07-25 19:06:33 expires_at=2026-10-23 19:06:33
OK    eas/base 0xacb7dc06ef… blk 49110131
        VOUCH  from=0x357458739f90461b99789350868cd7cf330dd7ee to=0x70d9e7a9dabf66d7bae8b7656e2a838b26707fe8
        scope=0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4
        issued_at=2026-07-25 20:00:09 expires_at=1970-01-01 00:00:00  (0 = perpetual sentinel, no expiry in this log)
…  [8 more]

10 verified, 0 failed, 10 rows total
every standardized edge matches an independently-fetched on-chain log, field for field
```

Conformance suite: **21 tests, 21 passed, 0 failed**, every fixture a real captured log (addresses,
topics, data, tx hash, block number verbatim).

---

## 7. Honest negatives

### 7.1 The Graph's Subgraph MCP is **not** in our live path

The server is reachable and speaks MCP (`https://subgraphs.mcp.thegraph.com/sse` → HTTP 200, tool
list returns). Every actual tool call fails, and so does the gateway directly — reproduced by us
just now:

```
$ curl -s -X POST "https://gateway.thegraph.com/api/$SUBSTREAMS_API_KEY/subgraphs/id/5zvR82…" \
    -H 'content-type: application/json' -d '{"query":"{_meta{block{number}}}"}'
{"errors":[{"message":"auth error: malformed API key"}]}
```

**Root cause, verified rather than guessed.** Our key is a **Graph Market** key — prefix `server_`,
39 characters — which authorizes Substreams and the Token API. The Subgraph MCP proxies to the
Subgraph **gateway**, which requires a **Subgraph Studio** key (32 hex chars). Decoding our JWT
shows what the account actually holds: `substreams_plan_tier = FREE`, `token_api_plan_tier = FREE`,
and no gateway entitlement claim of any kind. No amount of retrying converts one credential into the
other. **This is a config gap, not a code gap** — a Studio key would close it without touching
source.

### 7.2 `subgraph/` is not deployed

The directory holds a complete, compiled VouchMe subgraph (schema, manifest, four data sources,
handlers, `build/` artifacts) pointed at live mainnet addresses. It is **not deployed** and nothing
queries it — deploying to Studio needs the credential §7.1 establishes we do not have, and the app
reads the chain directly instead. It is also VouchMe-specific and therefore *not* the standardized
surface. **We are not claiming it.** Per gate 3, our submission would not qualify on it anyway.

### 7.3 Gnosis / Circles v2 is a worked example only

Circles' profile is trivial —
`Trust(address indexed truster, address indexed trustee, uint256 expiryTime)` gives `from_topic=1`,
`to_topic=2`, no scope, `vouch_tail=expires` (that one non-indexed word genuinely *is* a timestamp,
unlike EAS's). It is not in the live table for exactly one reason, and it is a **provider gap, not
a modelling gap**: Gnosis has no Firehose/Substreams endpoint from any provider. Re-verified:

```
$ substreams tools default-endpoint gnosis
Error: no endpoint found for network gnosis
$ substreams tools default-endpoint base
base-mainnet.streamingfast.io:443
$ getent hosts gnosis.streamingfast.io gnosis-mainnet.streamingfast.io gnosis.substreams.pinax.network
# all three: NXDOMAIN
```

`base` resolves under the identical mechanism with the identical credentials, which is what makes
this specific to Gnosis rather than an auth or tooling problem. Step 6 of the standard's
"adding a protocol" checklist — *confirm the chain has a Substreams endpoint* — exists because of
this finding.

### 7.4 EAS coverage is a recent window, not all history

`store_edges` is a Substreams store: it must process every block from `initialBlock` forward, with
no mid-chain cold start. VouchMe's profile therefore indexes its **entire** history (the contract is
days old — `initialBlock` is its real creation block, 32833177). The four EAS profiles start at a
documented recent block chosen because it provably contains real `Attested`/`Revoked` logs, verified
independently via Blockscout before streaming. EAS has been live since 2023; a full backfill is a
scale exercise, not a correctness one. **`trust_edges` holds EAS edges from those blocks onward, not
all of EAS.** The `initialBlock` values are in `substreams.yaml` with this stated inline.

### 7.5 Other bounded limitations

- **Free-tier concurrency cap.** `SUBSTREAMS_MAX_REQUESTS=2` on the free plan, so a re-index can
  fail transiently. `one-query-demo.sh --reindex` retries each network twice and prints its own
  PASS/FAIL and row delta per network rather than dying silently.
- **Cursors are per-profile.** Each adapter profile hashes to a different module hash and
  `substreams-sink-sql` resolves cursors by highest block, so running a second network against the
  same database is refused with `cursor module hash mismatch`. These are bounded backfills with
  nothing to resume, so the demo truncates `cursors` between networks. A production multi-network
  deployment wants one cursor table per profile.
- **`renew_count` is not a running total.** A single `updatePolicy: set` store cannot read its own
  prior state (self-reference is rejected: `modules graph has a cycle`), so a `REAFFIRM` writes `1`
  rather than incrementing. The correct fix — four single-purpose stores with `renew_count` on an
  `add` store — is written out in the `store_edges` doc comment. No live deployment has produced a
  `REAFFIRM`, so no stored value is currently wrong.
- **Two manifests, not one.** `substreams run` and `substreams-sink-sql run` cannot read the same
  manifest at the pinned versions — the CLI bundles `sf.substreams.sink.sql.v1.Service` and the sink
  binary does not, and importing it to satisfy the sink breaks streaming with a proto name conflict.
  `substreams.sink.yaml` exists solely for that, declares no modules of its own, and is kept in sync
  by a test that fails the build on drift.
- **The dataset is small and stated as such.** VouchMe is days old: two real humans enrolled through
  World App, one vouched for the other. That is the entire population of the contract, not a sample.

---

## 8. Reproduce it

Prerequisites: ClickHouse on `:8123` (container `vouchme-substreams-clickhouse`), `SUBSTREAMS_API_KEY`
/ `SUBSTREAMS_API_TOKEN` in root `.env`, `substreams` + `substreams-sink-sql` on `PATH`.

```bash
cd /home/ubuntu/projects/lisboa

# 1. The payoff: one standardized query, 2 protocols, 5 chains. (~2s, local ClickHouse only)
./substreams/scripts/one-query-demo.sh

# 2. The audit: re-derive every row from independent public RPCs. Expect "10 verified, 0 failed".
node substreams/scripts/crosscheck-trust-edges.mjs

# 3. The conformance suite: 21 tests, every fixture a real captured log.
cd substreams/vouchme-trust && cargo test && cd -

# 4. Live Firehose, VouchMe on World Chain mainnet.
set -a; . .env; set +a
cd substreams/vouchme-trust
substreams run ./substreams.yaml map_trust_events --network worldchain -e worldchain \
  -s 32835370 -t +20 -o jsonl

# 5. Live Firehose, EAS on Base — SAME .spkg, only --network differs. No recompile.
substreams run ./substreams.yaml map_trust_events --network base -e base \
  -s 49110120 -t +90 -o jsonl

# 6. Independent ground truth for VouchMe, plain eth_getLogs, no Substreams involved.
node ../scripts/verify-mainnet.mjs

# 7. Rebuild the whole standardized table from live streams on all five chains.
#    (Slower; hits the free-tier concurrency cap, so it retries and reports per-network.)
./substreams/scripts/one-query-demo.sh --reindex

# 8. The MCP consumer. Requires `node substreams/service/server.mjs` on :8790.
#    Same tool, same shape, three protocol/chain combinations:
#      0x4774b9621102eac2254365f9311c4e7700d9e7de  -> vouchme/worldchain
#      0x70d9e7a9dabf66d7bae8b7656e2a838b26707fe8  -> eas/base
#      0xfc61965861b679c5aa728d41fa6ea0b29544f554  -> eas/optimism
curl -s "http://127.0.0.1:8790/cross-protocol?address=0x70d9e7a9dabf66d7bae8b7656e2a838b26707fe8&direction=inbound&liveOnly=true"

# 9. Verify the negatives yourself.
substreams tools default-endpoint gnosis   # -> Error: no endpoint found for network gnosis
substreams tools default-endpoint base     # -> base-mainnet.streamingfast.io:443
```

### Where to look

| Path | What |
|---|---|
| `docs/17-trust-graph-standard.md` | **The standard.** Field table, edge identity, adapter profiles, adding a third protocol |
| `substreams/vouchme-trust/proto/trust_graph.proto` | The wire format |
| `substreams/vouchme-trust/schema.sql` | The relational form + the liveness predicate |
| `substreams/vouchme-trust/substreams.yaml` | The five adapter profiles — the whole cost of two protocols on five chains |
| `substreams/vouchme-trust/src/lib.rs` | Reference implementation; tests at `:1150`, `:1210`, `:1234` pin §4's three defects |
| `substreams/PROOF.md` §9–§12 | Chronological evidence trail, including the negatives with their real errors |
| `substreams/scripts/crosscheck-trust-edges.mjs` | The independent auditor |
| `mcp/src/tools/vouchme_cross_protocol_trust.ts` | The consumer with no per-protocol branching |
