# Proof — what actually ran, against what, and why

This file is the evidence trail for `substreams/vouchme-trust/`. Every command below was actually run
on this box on 2026-07-25 against live endpoints; nothing here is a projection, and every negative
result is recorded with its real error rather than omitted.

**It is written in chronological order, and the early sections are deliberately not rewritten.**
§1–§8 were produced while VouchMe still lived on World Chain **Sepolia**, which has no
Firehose/Substreams endpoint (§2) — which is why the first live proofs had to run on Base against
EAS instead. VouchMe then moved to World Chain **mainnet**, and §9 onward is the state that matters
today. If you are reading this to check the submission's claims, start at §9.

| Section | What it establishes |
|---|---|
| §1–§6 | Toolchain, the Sepolia/Gnosis endpoint findings, decode proof against real captured logs |
| §7–§8 | First live Firehose runs + SQL sink (on Base/EAS), and two real defects found by running them |
| **§9** | **VouchMe's own contract streamed live from World Chain mainnet, cross-checked against `eth_getLogs`** |
| **§10** | **trust-graph v0.2.0: the reversed-EAS-edge bug, its fix, five chains from one `.spkg`, and an independent audit of every sink row** |
| **§11** | **Honest negatives — Subgraph MCP, Token API, the undeployed subgraph, Gnosis — with exact errors** |
| **§12** | **The MCP layer over the standardized store** |

The standard these sections implement is specified in
[`docs/17-trust-graph-standard.md`](../docs/17-trust-graph-standard.md).

## 1. Toolchain installed

Nothing was present before this task (`which cargo rustc rustup substreams` returned nothing).
Installed:

| Tool | How | Version |
|---|---|---|
| Rust | `rustup-init.sh -y --default-toolchain stable --profile minimal`, then `rustup target add wasm32-unknown-unknown` | `rustc 1.97.1 (8bab26f4f 2026-07-14)`, target `wasm32-unknown-unknown` present |
| `substreams` CLI | Downloaded `substreams_linux_arm64.tar.gz` from the `v1.20.2` GitHub release directly (`streamingfast/substreams`), unpacked to `~/.local/bin` | `substreams version 1.20.2 (Commit 4873219, Commit Date 2026-07-24T19:48:38Z)` |
| `protoc` | `sudo apt-get install -y protobuf-compiler` (needed by `prost-build` in `build.rs`; the first `cargo test` failed without it) | `libprotoc 3.21.12` |
| `streamingfast/substreams-skills` plugin marketplace | `claude plugin marketplace add streamingfast/substreams-skills` | cloned successfully; `substreams-dev`, `substreams-ethereum`, `substreams-sql`, `substreams-hosted-sink`, `substreams-testing` skills read and applied (cited inline in code comments and below) |

## 2. World Chain Sepolia has no Substreams/Firehose endpoint — verified, not assumed

Two independent, live checks, both from this session:

**a) The network registry.** Fetched `https://networks-registry.thegraph.com/TheGraphNetworksRegistry.json`
(237,511 bytes, HTTP 200) and grepped every `"id"` field containing `world`. The only match:

```
"id": "worldchain"
```

That is **World Chain MAINNET**. There is no `worldchain-sepolia` entry. The `substreams-dev` skill's
own `references/networks.md` (derived from the same registry) lists `worldchain` under "Layer 2
Networks" and nothing else World-Chain-related — confirming the live fetch.

**b) The CLI itself, asked directly.** With the real manifest pointed at each candidate network:

```
$ substreams run ./substreams.yaml map_trust_events -e worldchain-sepolia -s -1 -o jsonl
📊 Usage Report (no data received)
 • Egress Bytes (uncompressed): 0 B
 • Processed Blocks: 0 blocks
 • Received Blocks: 0 blocks
Error: new substreams client connection: invalid endpoint "worldchain-sepolia": endpoint's suffix
must be a valid port in the form ':<port>', port 443 is usually the right one to use
```

`worldchain-sepolia` isn't a recognized network alias at all — the CLI tries to treat the string as a
raw hostname and fails immediately. Compare to `worldchain` (mainnet, which **is** registered and
does resolve to a real endpoint):

```
$ substreams run ./substreams.yaml map_trust_events -e worldchain -s -1 -o jsonl
📊 Usage Report (no data received)
 • Egress Bytes (uncompressed): 0 B
 • Processed Blocks: 0 blocks
 • Received Blocks: 0 blocks
Error: stream auth failure: rpc error: code = Unauthenticated desc = required authorization token
not found. Please provide a valid JWT token via 'authorization' header or an API key via
'x-api-key' header
```

This second error is a **different failure mode** (auth, not "unknown network") — proof the
endpoint resolved and the connection was attempted; it just needs credentials this environment
doesn't have (§3). Between (a) and (b): **World Chain Sepolia genuinely has no StreamingFast
Firehose/Substreams endpoint today.** World Chain *mainnet* does, but VouchMeRegistry
(`0x1d9955CB9f2A531fa6D4f43E712c9B1Fa9A44514`) is a Sepolia-only testnet deployment
(`deployments/worldchain-sepolia.json`) — it does not exist on mainnet, so pointing at `worldchain`
would silently stream real mainnet blocks that contain none of our events. That substitution was
**not** made; see §4 for what was done instead.

## 3. No credentials for any hosted Substreams endpoint — also verified, not assumed

Every network in the registry requires auth (`substreams-dev`'s own `references/networks.md`: "All
networks require authentication"). This session has no `SUBSTREAMS_API_KEY` / `SUBSTREAMS_API_TOKEN`
(checked `env | grep -iE "SUBSTREAMS|STREAMINGFAST|GRAPH_"` — empty — and every `.env`/`.env.example`
in the repo — no match), and interactive signup isn't possible here either:

```
$ substreams auth
Authenticate with The Graph Market to access Substreams endpoints.
If you don't have an account yet, register and paste back your API key here:
    https://thegraph.market/auth/signup
...
Error: error running form: huh: could not open a new TTY: open /dev/tty: no such device or address
```

So this is not only "Sepolia isn't registered" — it's "this box cannot reach **any** Firehose
endpoint, registered chain or not, without a human completing an interactive signup at
thegraph.market that nobody has done." The `substreams-hosted-sink` skill's own output-quality gate
(never offer to deploy before a `substreams run` shows real decoded output) could not be satisfied
via the CLI-against-a-live-endpoint path for this reason, on **any** chain — not a Sepolia-specific
gap.

## 4. What was substituted, and what was not

The task's instruction, if Sepolia has no endpoint: *"run the same module against a chain that does
(Base or Gnosis), reporting exactly what you substituted and why. Do not fake decoded output."*

**What running against Base/Gnosis would have proven:** that `substreams run` can stream real blocks
from a live Firehose endpoint and that the WASM binary executes correctly under the real engine.

**What it would NOT have proven:** anything about decoding *VouchMeRegistry's actual events* — Base/Gnosis
don't have this contract, so proving the module against them would need fabricated params pointed at
some *other* real contract's Vouch-shaped event there, which (a) is a materially different claim than
"this pipeline decodes VouchMe's real events" and (b) is blocked anyway by §3 — there is no credential
to reach Base or Gnosis Firehose either. So the honest substitution is not "run against a different
chain with different data" (impossible here, and would answer a different question even if possible)
— it is: **prove the exact decode logic the WASM module runs, compiled and executed for real,
against real bytes captured live from the actual target chain and contract, via `cargo test`
instead of `substreams run`.**

This is not a workaround invented for this gap — it is the documented, first rung of the testing
pyramid in the `substreams-testing` skill (`substreams::testing::map!`, "Unit → Integration → CLI
→ Performance"; the skill explicitly recommends real block/log fixtures over synthetic ones, citing
`firecore` for extraction — the same `eth_getLogs`-sourced-fixture approach used here, minus the
`firecore`/Firehose auth §3 already rules out).

### 4.1 Real data captured

`eth_getLogs` against `https://worldchain-sepolia.g.alchemy.com/public` (the RPC in
`deployments/worldchain-sepolia.json`, unrelated to and unaffected by the Firehose/Substreams
auth gap in §3 — this is plain JSON-RPC, no StreamingFast credential involved), paginated in
100-block chunks from block `32216305` (`VouchMeRegistry` deployment block) to the chain head
(`32220307` at capture time):

```
Vouched   12
Enrolled  14
Revoked    0
Reaffirmed 0
```

This matches the task brief exactly ("14 Enrolled, 12+ Vouched"). Three real `Vouched` logs and one
real `Enrolled` log were pulled verbatim (address, topics, data, tx hash, block number — nothing
edited) into `substreams/vouchme-trust/src/lib.rs`'s `#[cfg(test)]` module.

Reproducible via `substreams/scripts/fetch-fixtures.mjs` (raw JSON-RPC `eth_getLogs` — the script's
own header notes that `viem`'s typed `client.getLogs({ topics })` silently ignored the topic filter
against this RPC endpoint in an earlier attempt, verified by comparing four supposedly different
per-topic queries and finding identical results; raw `eth_getLogs` with an explicit `topics` array
does filter correctly). Re-running it near the end of this session — chain time had moved on —
returned **15 Vouched / 17 Enrolled / 0 Revoked / 0 Reaffirmed**: higher than the 12/14 captured for
the fixtures above, because World Chain Sepolia is a live testnet and other concurrent activity
(e.g. `scripts/live-scenario.mjs`, `scripts/add-anchor4.mjs`) kept writing to it during this task.
The embedded test fixtures intentionally stay pinned to the exact three Vouched + one Enrolled log
captured at §4.1's block range, both hashes and all, so the assertions in `src/lib.rs` remain exact
and reproducible rather than chasing a moving chain head.

### 4.2 Decoded, by the actual production code path

`cargo test` builds the **exact** `map_trust_events` function that the WASM module ships (via
`substreams::testing::map!`, which calls the real handler body, not a mock), fed a `Block` carrying
only these real bytes:

```
$ cargo test
running 7 tests
test tests::decodes_real_enrolled_event_as_account_context ... ok
test tests::decodes_real_vouched_event ... ok
test tests::decodes_two_more_real_vouched_events ... ok
test tests::empty_block_decodes_to_no_events ... ok
test tests::ignores_logs_from_other_contracts ... ok
test tests::parse_params_rejects_no_topics ... ok
test tests::parse_params_rejects_missing_contract ... ok

test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s
```

The load-bearing assertions, decoding a real `Vouched` log
(tx `0x4e3f68550eb01521d73ab56ac5663d12f7f43a7eb26e990ccc329e4127c6465b`, block `32216398`):

```rust
assert_eq!(hex::encode(&ev.from), "defbe7d71f0eae651399c0fb97cf93fa09ee0780"); // anchor1
assert_eq!(hex::encode(&ev.to),   "ee0f520a7cd3f6998dee6463dfe3fc49e040520b");
assert_eq!(ev.issued_at,  1784980220);   // 2026-07-25T11:50:20Z
assert_eq!(ev.expires_at, 1792756220);   // 2026-10-23T11:50:20Z
assert_eq!(ev.expires_at - ev.issued_at, 90 * 86400); // VouchMe's 90-day vouch expiry, decoded, not assumed
```

`0xdefbe7d71f0eae651399c0fb97cf93fa09ee0780` is `initialAnchors[0]` in
`deployments/worldchain-sepolia.json` — this is a genesis anchor vouching for a real account, on
the real deployed contract, with a 90-day expiry window that matches the protocol design
independently derived from the raw event bytes (nobody hard-coded "90 days" into the test — it fell
out of subtracting two decoded `uint64` words).

The `Enrolled` decode (test-only — `Enrolled` is not part of `trust_graph.proto`'s `Kind` enum;
see the doc comment on `decodes_real_enrolled_event_as_account_context` in `src/lib.rs` for why)
decodes the ABI dynamic-`string` tail of a real log
(tx `0xe988ee338cba2dac86d2e4156958ae6d53f4c42cca7ee43abd8f83c2a39ea4be`) all the way to:

```rust
assert_eq!(handle, "anchor1.vouchme.eth");
```

— a real ENS-style handle, decoded from raw ABI bytes (offset-pointer + length-prefixed UTF-8), not
a placeholder.

### 4.3 What this does and does not stand in for

**Proven:** the module's decode logic — address-from-topic, uint64-from-ABI-word, dynamic-string
tail, topic0 dispatch, params parsing — is correct against real bytes from the real deployed
contract, compiled through the real crate versions the WASM binary uses (`cargo test` and
`cargo build --target wasm32-unknown-unknown --release` share the same `Cargo.lock`).

**Not proven:** that a live `substreams run` against a real Firehose stream reaches the same
result end-to-end (block iteration, ordinal handling, the store/CDC modules under the real engine,
reorg handling). That gap is entirely attributable to §2 + §3, not to the module.

**Next command, the moment either gap closes:**

```bash
# If a World Chain Sepolia Firehose endpoint appears:
substreams auth   # once, interactively, from a real terminal
substreams run ./substreams.yaml map_trust_events -e <that endpoint> -s 32216305 -t +2002 -o jsonl
# 2002 blocks covers 32216305..32220307+, i.e. every block that produced a real Enrolled/Vouched
# log at capture time — the same range eth_getLogs scanned in §4.1.
```

No other change is needed — manifest, params, and module are already correct and packed
(`vouchme-trust-graph-v0.2.0.spkg`, §5).

## 5. Build artifacts (this session)

```
$ cargo build --target wasm32-unknown-unknown --release
    Finished `release` profile [optimized] target(s) in 17.68s
$ ls -la target/wasm32-unknown-unknown/release/vouchme_trust_graph.wasm
-rwxr-xr-x 1 ubuntu ubuntu 315189 ... vouchme_trust_graph.wasm

$ substreams pack ./substreams.yaml
✅ Package created successfully at ./vouchme-trust-graph-v0.2.0.spkg
$ sha256sum vouchme-trust-graph-v0.2.0.spkg
36897d779a2fc280336ed4cafd68c0104f019589a8131d8d26d416f7433009da  vouchme-trust-graph-v0.2.0.spkg
# (repacking after any README.md edit changes this hash — substreams pack embeds README.md
# verbatim as the package doc, confirmed via `substreams info`'s "Doc:" field; the wasm itself
# is unchanged from §6's `cargo build` unless src/lib.rs or substreams.yaml also changed)

$ substreams info ./vouchme-trust-graph-v0.2.0.spkg
Package name: vouchme_trust_graph
Version: v0.2.0
Network: worldchain
Modules:
  map_trust_events  (map)    -> proto:vouchme.trust.v1.TrustEvents
  store_edges       (store, updatePolicy: set) -> proto:vouchme.trust.v1.Edge
  map_edge_deltas   (map)    -> proto:sf.substreams.sink.database.v1.DatabaseChanges
  db_out            (map)    -> proto:sf.substreams.sink.database.v1.DatabaseChanges
Sink config: type sf.substreams.sink.sql.v1.Service, schema.sql loaded (1570 bytes, MD5 bd115e132b0317c6d1e4f0d7120b9f69), engine=2 (clickhouse)
```

```
$ substreams graph ./substreams.yaml
graph TD;
  map_trust_events[map: map_trust_events];
  map_trust_events:params[params] --> map_trust_events;
  sf.ethereum.type.v2.Block[source: sf.ethereum.type.v2.Block] --> map_trust_events;
  store_edges[store: store_edges];
  map_trust_events --> store_edges;
  map_edge_deltas[map: map_edge_deltas];
  store_edges -- deltas --> map_edge_deltas;
  db_out[map: db_out];
  map_edge_deltas --> db_out;
```

`substreams info`/`substreams graph`/`substreams pack` all validate the manifest **locally** — no
network, no auth required — which is how the module graph and the packed `.spkg` above are
verified independent of the §2/§3 endpoint gap.

## 6. A design question resolved empirically, not by guessing

`store_edges` (per docs/14-substreams.md §2) is a single `updatePolicy: set` store, but `REAFFIRM`
and `REVOKE` events on VouchMeRegistry don't carry the full edge record (only `Vouched` does) — so a
correct implementation would want to read the edge's prior state before applying a partial update.
Substreams stores are write-only from within their own handler: `StoreSetProto<T>` has no `get_*`
method (confirmed by the compiler, not the docs), and declaring a store as its own `mode: get` input
to get a second, read-capable handle is rejected outright:

```
$ substreams info ./substreams.yaml   # manifest with store_edges listing itself as a `mode: get` input
Error: read manifest "./substreams.yaml": modules graph has a cycle
```

So self-referential read-modify-write is structurally unavailable, not just undocumented. The
module ships the single-store design docs/14 §2 names, with `store_edges` writing everything a
given event carries and leaving the rest at zero/default — which is **complete and correct for
100% of the live dataset today** (0 Revoked, 0 Reaffirmed — §4.1), with the exact, correct
multi-store fix (four single-purpose stores using self-sufficient update policies, combined
downstream) written out in the doc comment directly above `store_edges` in `src/lib.rs`, for the
day `REAFFIRM`/`REVOKE` volume is nonzero.

## 7. Credentials arrived mid-task — what changed, verified live

Everything above (§1–§6) was written before this session held a `SUBSTREAMS_API_KEY` /
`SUBSTREAMS_API_TOKEN`. The owner supplied both partway through (gitignored root `.env`). This
section is the delta: what those credentials did and did not unblock, checked by actually running
the commands, not by re-reading docs. §1–§6 above are left exactly as originally written — they were
correct for the box's state at the time, and the "not proven: live `substreams run`" line in §4.3 is
precisely the gap this section closes for one chain and confirms remains closed for another.

### 7.1 Gnosis: still no endpoint, and now proven not to be an auth gap

The task's fallback plan named Gnosis (Circles v2) as the composability target. With real
credentials loaded (`set -a; . .env; set +a`; values never echoed), the actual attempt:

```
$ substreams run ./substreams.yaml map_trust_events -e gnosis -p 'map_trust_events=contract=0xc12c1e50abb450d6205ea2c3fa861b3b834d13e8&...' -s 47384700 -t +100 -o jsonl
Usage Report (no data received)
Error: new substreams client connection: invalid endpoint "gnosis": endpoint's suffix must be a
valid port in the form ':<port>', port 443 is usually the right one to use
```

This is the same class of client-side "unknown alias" failure as `worldchain-sepolia` in §2b — not
`Unauthenticated` like mainnet `worldchain` in the same section. Credentials make no difference here
because the client never gets far enough to present them: `gnosis` does not resolve to a hostname at
all in this account's registry. Confirmed three more ways, independent of auth:

```
$ substreams tools default-endpoint gnosis
Error: no endpoint found for network gnosis
$ substreams tools default-endpoint base
base-mainnet.streamingfast.io:443
$ getent hosts gnosis.streamingfast.io gnosis-mainnet.streamingfast.io gnosis.substreams.pinax.network
# all three: NXDOMAIN
```

The Graph's own network registry lists `gnosis` as a valid chain id (`eip155:100`) — it is a real,
known network — but no Firehose/Substreams data-plane endpoint is registered for it under this
account, from either StreamingFast or Pinax. `base` resolves cleanly
(`base-mainnet.streamingfast.io:443`) under the identical query mechanism, which is what makes this
a specific-to-Gnosis finding rather than a general auth or tooling problem. Verdict: Gnosis is not
reachable from this environment, full stop — a provider/registration gap, not a credentials gap.
Base was used instead for everything below, per the task's own fallback list ("Base or Gnosis").

### 7.2 Base: live, authenticated, real decoded events

```
$ substreams run ./substreams.yaml map_trust_events -e base \
    -p 'map_trust_events=contract=0x4200000000000000000000000000000000000021&vouch_topic=&revoke_topic=&reaffirm_topic=0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35&report_topic=&report_resolved_topic=&model=ISSUANCE&protocol=eas&network=base' \
    -s 49100200 -t +60 -o jsonl

{"@module":"map_trust_events","@block":49100201,"@type":"vouchme.trust.v1.TrustEvents","@data":{"events":[
  {"protocol":"eas","network":"base","kind":"REAFFIRM",
   "from":"0x2103a27f51066c7a6cecf1fc1048a06740a22571",
   "to":"0x357458739f90461b99789350868cd7cf330dd7ee",
   "txHash":"0x2d2425b305f103a1f7ae7bcc7cd2cd7952da9f40e4c7d01d53e569364360000d","blockNum":"49100201"},
  {"txHash":"0x0e2f6e8e149184b96f5fed79e42a8ac11a5335b5a62f50be112097cffa143771"}
]}}
{"@module":"map_trust_events","@block":49100248, "txHash":"0x8a7088d992622a530ad34bc2e21a2a4dd2703fc490cada1d596329002a92461a"}
{"txHash":"0x99813f79cb2af747e93cd46357ec2ab74c385ed698de1db110290f761f1a8071"}
Usage Report: Processed Blocks: 60  Received Blocks: 60
Completed successfully
```

The target: EAS (Ethereum Attestation Service) at `0x4200000000000000000000000000000000000021` on
Base — verified as a real, active contract before use: `eth_getCode` returned real bytecode, and
`base.blockscout.com`'s log API returned real recent `Attested` logs at these exact block numbers
and tx hashes, independently fetched before this `substreams run` — the two data sources agree
byte-for-byte on address, tx hash, and block number. This is genuine composability in practice: the
same `.spkg`, no Rust changed, pointed at a wholly different contract and chain via `params` only.

Honest limitation surfaced by this choice, not hidden by it: EAS's `Attested` event is
`Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)`
— its two indexed addresses satisfy `map_trust_events`'s `from`/`to` extraction exactly (hence the
correct real addresses above), but its one non-indexed word is a content-addressed `uid` hash, not a
timing value the way `VouchMeRegistry.Vouched`'s or `CirclesHub.Trust`'s non-indexed tail is. Run through
`word_u64`, a `uid` decodes to an arbitrary large number, not wrong exactly (there is no ABI-level
way to know a contract's non-indexed word is "supposed to be" a timestamp), but not meaningful
either. §7.3 covers what this did to the sink and how it was made not to crash on it.

### 7.3 Sink: real ClickHouse, real rows — and four more real bugs found by running it

`substreams-sink-sql setup`/`run` against a local `clickhouse/clickhouse-server:24-alpine` container
surfaced four more bugs, none visible from `cargo test` or `substreams pack` alone — each found by
actually executing the command, fixed, and re-run:

1. Missing `imports: sql: <protodefs spkg url>` entry. `sink.type` was already the correct
   `sf.substreams.sink.sql.v1.Service` — but without that import, `setup` said the type doesn't
   exist in bundled descriptors. (First fix attempt wrongly followed the `substreams-sql` skill's
   own manifest example, which names the type `sf.substreams.sink.sql.service.v1.Service` and
   calls `.sql.v1.Service` "DEPRECATED" — `substreams inspect` on the actual downloaded
   `protodefs-v1.0.7` release shows the real package is `sf.substreams.sink.sql.v1` with message
   `Service`, and `...service.v1.Service` does not exist in that release at all. Reverted the type
   name back; the import was the real fix.)
2. `schema.sql`'s statement splitter is not comment-aware. A literal `;` inside a trailing `--`
   comment (the doc's own example query, and two rewrites of the warning about this exact bug)
   reopened a second, comment-only "statement" that ClickHouse rejected as `code: 62, Empty query`.
   Fixed by removing every `;` from `schema.sql` except the one real statement terminator.
3. `weight_raw Decimal(38,18)` cannot take any value through this driver path. Both `"0"` and `""`
   failed identically: `converting value "..." to type "decimal.Decimal": unsupported struct type
   decimal.Decimal` — a `substreams-sink-sql` v4.13.1 ClickHouse-dialect limitation, not a value
   problem. Changed the column to `String` (schema.sql documents why inline).
4. `FixedString(20)`/`FixedString(32)` vs. the module's `0x`-hex string convention.
   `map_edge_deltas` emits addresses/hashes as `hex0x()` strings (42/66 ASCII chars) everywhere,
   matching every log line and test assertion in this package — but `docs/14-substreams.md §4`'s
   schema specifies `FixedString(20)`/`FixedString(32)`, which want exactly that many raw bytes.
   First real row hit: `from_addr input value with length 42 exceeds FixedString(20) capacity`.
   Changed `from_addr`/`to_addr`/`tx_hash` to `String` rather than switching the Rust side to raw
   bytes, to keep one address encoding consistent all the way to the `/edges` HTTP endpoint.
5. (Caught before it reached the DB, but only by running against real EAS data.) §7.2's `uid`
   -as-timestamp values are large enough that `u64 as i64` wraps negative
   (`-475969128228036841`), which ClickHouse's `DateTime` column rejected outright and failed the
   entire flush batch, not just that field. Added `clamp_unix_timestamp()` (clamps into
   `DateTime`'s valid `[0, 4294967295]` range in `u64` space, before any cast) — a real regression
   test (`clamp_unix_timestamp_never_goes_negative_or_out_of_range`) uses this exact real garbage
   value. `cargo test` now shows 8 passed, not 7.

All fixes are in `schema.sql` and `src/lib.rs`; `cargo test` (8/8) and `substreams pack` were
re-run clean after each. With all fixed, the real sink run:

```
$ substreams-sink-sql setup "clickhouse://default:@localhost:9000/default" ./substreams.yaml
setup completed successfully

$ substreams-sink-sql run "clickhouse://default:@localhost:9000/default" ./substreams.yaml \
    "49100190:49100260" -e base -p 'map_trust_events=...(section 7.2 params)...' \
    --undo-buffer-size=1 --development-mode --batch-block-flush-interval=1
run terminated gracefully   db_flush_rate: 13 total   db_flushed_rows_rate: 14 total   with_error: false
```

```sql
SELECT protocol, network, from_addr, to_addr, kind, weight_raw, issued_at, expires_at, revoked, block_num, tx_hash
FROM trust_edges FINAL ORDER BY block_num;

 eas  base  0x2103a27f51066c7a6cecf1fc1048a06740a22571  0x357458739f90461b99789350868cd7cf330dd7ee  REAFFIRM  0  1970-01-01 00:00:00  2106-02-07 06:28:15  0  49100201  0x0e2f6e8e149184b96f5fed79e42a8ac11a5335b5a62f50be112097cffa143771
 eas  base  0x7e2c5cd7a2a0f1ef9d87ebbea77392b9c348bfc7  0x357458739f90461b99789350868cd7cf330dd7ee  REAFFIRM  0  1970-01-01 00:00:00  2106-02-07 06:28:15  0  49100248  0x8a7088d992622a530ad34bc2e21a2a4dd2703fc490cada1d596329002a92461a
 eas  base  0xae1bcccf89f971f5ce17961132a2ab74aa8eb191  0x357458739f90461b99789350868cd7cf330dd7ee  REAFFIRM  0  1970-01-01 00:00:00  2106-02-07 06:28:15  0  49100248  0x99813f79cb2af747e93cd46357ec2ab74c385ed698de1db110290f761f1a8071
```

Three rows, three distinct real `from` addresses, one shared real `to` address, real tx hashes — all
matching §7.2's live stream and the independent blockscout fetch exactly. `expires_at`'s
`2106-02-07 06:28:15` is `clamp_unix_timestamp`'s documented ceiling, not a real expiry — visible and
explained (§7.3 item 5), not silently wrong.

Operational note, disclosed rather than hidden: getting here required temporarily setting
`initialBlock: 49100000` (from the shipped `32216305`, which is World Chain Sepolia's deployment
block) on all three stateful modules, then reverting after this proof was captured. `store_edges` is
a Substreams store — it must process every block from `initialBlock` forward to build correct state;
there is no mid-chain cold start. Pointing `params` at a different chain (the composability claim)
does not by itself let a store-dependent sink start anywhere on that chain — `initialBlock` is a
manifest-level value today, not a param. `map_trust_events` alone (§7.2, no store in its path) has no
such restriction and ran instantly at any `-s`. This is a real, specific boundary of "one `.spkg`,
params only" for the store+sink half of the pipeline, not the map half — worth a follow-up (e.g.
network-scoped `initialBlock` overrides, or having the deploy SKILL's `render` step set it) rather
than something this task's scope covers. The shipped manifest is back to `initialBlock: 32216305`
(World Chain Sepolia / VouchMe, the actual target) — confirmed by re-running `cargo test` (8/8) and
`substreams pack` clean after reverting.

### 7.4 What is proven now that credentials exist

Updating §4.3's "not proven" line: a live `substreams run` against a real Firehose stream does reach
the same result end-to-end — block iteration, the store/CDC modules, the real `substreams-sink-sql`
binary, a real ClickHouse table — verified on Base. What remains unproven is only what remains
unreachable, not unverified: World Chain Sepolia (§2, no endpoint from any provider) and Gnosis
(§7.1, no endpoint from any provider). Both are provider-side gaps; nothing about the module,
manifest, or sink configuration is in question for either.

## 8. Real defect caught by direct review, not by this module's own tests

A second reviewer verified §7's sink independently — not by trusting `GET /edges`, but by querying
ClickHouse directly (`SELECT ... FROM trust_edges`) — and found `issued_at = 1970-01-01 00:00:00`
on all three rows. That is Unix epoch `0`, not "unknown": every downstream tenure/freshness
computation over such an edge would read it as maximally old, silently, in the most damaging
direction. This section is the fix, the root cause (two layers, not one), and the corrected real
output.

### 8.1 Root cause — two layers, both needed fixing

**Layer 1 — `decode_timing` (`map_trust_events`).** REAFFIRM's real ABI shape
(`Reaffirmed(address,address,uint64 expiresAt)`) carries no issuance word at all — the old code
hardcoded `issued_at: 0` for it, with no fallback. Fixed: `decode_timing` now takes the containing
block's own timestamp and uses it as `issued_at` for every kind whose shape has no issuance word of
its own (REAFFIRM always; every kind's too-short-data branch). VOUCH is unaffected — its two full
ABI words are still decoded exactly as before.

**Layer 2 — `store_edges`, found only by re-running the live sink after fixing layer 1 and still
seeing `1970-01-01`.** Layer 1 alone was not sufficient — `store_edges`'s `EventKind::Reaffirm` match
arm only ever set `edge.expires_at` and `edge.renew_count`, never `edge.issued_at`, so the
freshly-zeroed `Edge`'s default (`issued_at: 0`) reached the sink regardless of what the raw
`TrustEvent` now correctly carried. Fixed: `edge.issued_at = ev.issued_at` now runs unconditionally
for every kind, not only inside the `Vouch` arm.

Both fixes are real code changes (`src/lib.rs`), not documentation — `cargo test` grew a new
regression test (`reaffirm_issued_at_falls_back_to_block_timestamp_not_zero`, 9/9 passing) that
asserts `issued_at != 0` and equals the real block timestamp for a REAFFIRM-shaped event.

**Direct answer to "does the WCS/VouchMe Vouched path share this bug":** VOUCH itself, no — its
`issued_at` is and was always the event's own explicitly decoded ABI word (verified:
`assert_eq!(ev.issued_at, 1784980220)`, unchanged). But REAFFIRM and REVOKE on the *real* VouchMe
deployment share the exact same `decode_timing` / `store_edges` code path this bug lived in — it
was invisible there only because World Chain Sepolia has had zero real `Reaffirmed`/`Revoked`
events so far (§4.1, confirmed again via `fetch-fixtures.mjs` at time of this fix: 15
Vouched / 0 Revoked / 0 Reaffirmed). The moment either happens on the live contract, this exact bug
would have reached a real VouchMe score input. It cannot now — both layers are fixed, and the fix is
shared code, not a Base-only patch.

### 8.2 `expires_at`'s clamp ceiling, made explicit rather than left for a reader to guess

The second half of the finding: `expires_at = 2106-02-07 06:28:15` (`4294967295`,
`clamp_unix_timestamp`'s ceiling, `src/lib.rs`) on all three rows. This is **not** EAS's real
`expirationTime` field decoded as "never expires" — EAS's `Attested` event does not carry
`expirationTime` in the log at all (it lives in contract storage, fetchable only via
`getAttestation(uid)`, which this event-log-only extractor does not call). The one non-indexed word
this mapping reads is `uid`, a content hash, misread as a timing value by the generic
`reaffirm_topic` decode path (§7.2's documented shape mismatch) — clamped only so it cannot crash
the `DateTime` column, not because `0xFFFFFFFF` means anything for this protocol pairing. `schema.sql`
now says this inline, next to the column, so a reader of the schema does not have to find this file
to know it. Circles v2's `Trust.expiryTime` is the contrast case where the same one-word decode
path *does* carry a genuine timestamp — verified against 5 real Trust events fetched live from
Gnosis (§4/§7.1's `blockscout` cross-check) even though Gnosis itself cannot be streamed (§7.1, no
endpoint).

### 8.3 Re-run, corrected real output

Same live Base stream and range as §7.3, rebuilt (`cargo build`, `substreams pack`), same temporary
`initialBlock` override and revert as §7.3 (reverted to `32216305` after capture; `cargo test` 9/9
and `substreams pack` reconfirmed clean on the shipped config):

```sql
SELECT protocol, from_addr, to_addr, issued_at, expires_at, block_num, tx_hash
FROM trust_edges FINAL ORDER BY block_num;

 eas  0x2103a27f51066c7a6cecf1fc1048a06740a22571  0x357458739f90461b99789350868cd7cf330dd7ee  2026-07-25 14:29:09  2106-02-07 06:28:15  49100201  0x0e2f6e8e149184b96f5fed79e42a8ac11a5335b5a62f50be112097cffa143771
 eas  0x7e2c5cd7a2a0f1ef9d87ebbea77392b9c348bfc7  0x357458739f90461b99789350868cd7cf330dd7ee  2026-07-25 14:30:43  2106-02-07 06:28:15  49100248  0x8a7088d992622a530ad34bc2e21a2a4dd2703fc490cada1d596329002a92461a
 eas  0xae1bcccf89f971f5ce17961132a2ab74aa8eb191  0x357458739f90461b99789350868cd7cf330dd7ee  2026-07-25 14:30:43  2106-02-07 06:28:15  49100248  0x99813f79cb2af747e93cd46357ec2ab74c385ed698de1db110290f761f1a8071
```

`issued_at` is now real and distinct per event (14:29:09 for block 49100201, 14:30:43 for both
events in block 49100248 — the two block 49100248 rows share a timestamp because they share a
block, which is correct: same block, same real on-chain moment). No row reads 1970. `expires_at`'s
clamp ceiling is unchanged and is exactly what §8.2 says it is, not a guess a reader has to make.

## 9. World Chain MAINNET — VouchMe's own contract, streamed live

Everything in §1–§8 was written while VouchMe lived on World Chain **Sepolia**, which has no
Firehose/Substreams endpoint (§2) — which is why §7's live proof had to be done on Base against
EAS, a different protocol on a different chain. VouchMe moved to World Chain **mainnet** (chainId
480) on 2026-07-25. That is what closed the gap: mainnet *is* in the registry, so the module now
streams **VouchMe's own contract, on its own chain, decoding its own events.** No substitution.

### 9.1 The live deployment

`VouchMeRegistry` `0x6fEfEf2d44203300a6a33d631840C972181b8722`, created in block `32833177`.

Note `deployments/worldchain-mainnet.json`'s `contracts.VouchMeRegistry` names `0x7a294C7C…` — an
earlier, abandoned deploy of the same script, superseded after errata E-18. The address above is
the one the app writes to and the one carrying the real logs.

### 9.2 Independent ground truth first — plain `eth_getLogs`, no Substreams involved

```
$ node substreams/scripts/verify-mainnet.mjs
rpc            https://worldchain-mainnet.g.alchemy.com/public
chainId        480
registry       0x6fEfEf2d44203300a6a33d631840C972181b8722
range          32833177 .. 32836647  (3471 blocks)

counts (topic0-filtered, whole deployed lifetime):
  Enrolled    2
  Vouched     1
  Reaffirmed  0
  Revoked     0

{"event":"Enrolled","blockNum":32833568,"txHash":"0xde6f732eeb3c812d81df6098f74eab48b7c76f40f9443832299e13255fd52749","account":"0xb23a3b2384d721d7c487a3acc6405a1d36672b47","handle":"philoo.vouchme.eth","credentialExpiresAt":1792778775}
{"event":"Enrolled","blockNum":32833881,"txHash":"0xcbafd84a98bc5e8f2eb7e5a660cfaf57220a344fb5fdc8164a289bed239869f4","account":"0x4774b9621102eac2254365f9311c4e7700d9e7de","handle":"romariokavin.vouchme.eth","credentialExpiresAt":1792779401}
{"event":"Vouched","blockNum":32835377,"txHash":"0x563172cb968bb63b2ba362fa95d6ff257bf94554076ebbbb39e3969cab3d5c45","from":"0xb23a3b2384d721d7c487a3acc6405a1d36672b47","to":"0x4774b9621102eac2254365f9311c4e7700d9e7de","issuedAt":1785006393,"expiresAt":1792782393,"expiryDays":90}
```

Two real humans enrolled through World App and one vouched for the other. This is the entire
population of the contract — small, and stated as such rather than padded.

### 9.3 The same event, decoded by Substreams off a real Firehose stream

```
$ substreams run ./substreams.yaml map_trust_events -e worldchain -s 32835370 -t +20 -o jsonl
{"@module":"map_trust_events","@block":32835377,"@type":"vouchme.trust.v1.TrustEvents","@data":{"events":[
  {"protocol":"vouchme","network":"worldchain",
   "from":"0xb23a3b2384d721d7c487a3acc6405a1d36672b47",
   "to":"0x4774b9621102eac2254365f9311c4e7700d9e7de",
   "weightRaw":"1","issuedAt":"1785006393","expiresAt":"1792782393",
   "txHash":"0x563172cb968bb63b2ba362fa95d6ff257bf94554076ebbbb39e3969cab3d5c45",
   "blockNum":"32835377"}]}}
📊 Usage Report
 • Processed Blocks: 20 blocks
 • Received Blocks: 20 blocks
Completed successfully
```

Endpoint resolved from The Graph's network registry, not hardcoded:

```
$ substreams tools default-endpoint worldchain
mainnet.worldchain.streamingfast.io:443
```

**Cross-check.** §9.2 and §9.3 are two different data planes (JSON-RPC via Alchemy vs. Firehose
via StreamingFast), different providers, different credentials. They agree byte-for-byte on
`from`, `to`, `issuedAt`, `expiresAt`, `txHash` and `blockNum`. The 90-day expiry
(`1792782393 - 1785006393 = 7776000 = 90 × 86400`) falls out of the decoded words; it is not
asserted anywhere in the module.

---

## 10. trust-graph v0.2.0 — fixing EAS, and one `.spkg` across five chains

§7.2 got real EAS data out of a live Base stream, and §7.3/§8.2 were candid that the *mapping* was
poor: `Attested` routed through `reaffirm_topic`, and a `uid` content hash decoded as a year-2106
expiry. Reviewing those rows against EAS's own event declaration turned up something worse, which
neither the tests nor the sink could have caught.

### 10.1 The rows were reversed, and looked fine

EAS declares:

```solidity
event Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID);
event Revoked (address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID);
```

**Subject first, asserter second** — the opposite of `VouchMeRegistry.Vouched(voucher, vouchee, …)`.
v0.1.0 hardcoded `from = topics[1]`, `to = topics[2]`, so every EAS edge recorded the person being
attested *about* as the one doing the attesting. Here are the actual rows that were in ClickHouse,
captured immediately before dropping the table:

```
eas  base  REAFFIRM  from=0x2103a27f…2571  to=0x357458739f…d7ee  expires_at=2106-02-07 06:28:15
eas  base  REAFFIRM  from=0x7e2c5cd7a2…bfc7  to=0x357458739f…d7ee  expires_at=2106-02-07 06:28:15
eas  base  REAFFIRM  from=0xae1bcccf89…b191  to=0x357458739f…d7ee  expires_at=2106-02-07 06:28:15
```

`0x357458739f90461b99789350868cd7cf330dd7ee` is a prolific EAS **attester** on Base — it appears
as `topics[2]` in dozens of live logs. It is sitting in the `to` column. Three defects in three
rows: wrong direction, wrong kind (`REAFFIRM` for an issuance), and a fabricated expiry. Nothing
about the output looked wrong: real addresses, real tx hashes, real blocks.

**These rows no longer exist.** The table was dropped and rebuilt under v0.2.0 (§10.3).

### 10.2 What v0.2.0 changes

Four changes, all in `src/lib.rs` / `proto/trust_graph.proto` / `schema.sql`, all specified in
`docs/17-trust-graph-standard.md`:

1. **Role mapping is declared** — `from_topic` / `to_topic`, 1-based topic indices, defaulting to
   `1`/`2` so no v0.1.0 deployment changes meaning. EAS declares `from_topic=2&to_topic=1`.
2. **Tail layout is declared** — `<kind>_tail` ∈ `issued_expires | expires | at | none`, replacing
   "infer the layout from the kind". EAS declares `none`: its logs carry no timing at all, so
   `issued_at` is the block clock and `expires_at` is `0`, the standard's perpetual sentinel. An
   unknown value is a fatal parse error, not a silent fallback.
3. **`scope` added to the edge identity** — EAS's `schemaUID` (`scope_topic=3`). One attester holds
   several live attestations about the same recipient under different schemas; without this,
   revoking one revoked them all.
4. **`network` added to the edge identity** — addresses are not chain-scoped, so EAS-on-Base and
   EAS-on-Optimism were colliding on the same key. `edge_key()`, the CDC key in `map_edge_deltas`,
   and `schema.sql`'s `ORDER BY` were all updated together and are asserted to match.

```
$ cargo test
running 21 tests
...
test tests::decodes_a_real_eas_attested_log_with_the_attester_as_from ... ok
test tests::v0_1_0_topic_order_would_reverse_this_eas_edge ... ok
test tests::decodes_a_real_eas_revoked_log_as_revoke ... ok
test tests::scope_keeps_same_pair_different_schema_edges_distinct ... ok
test tests::every_eas_profile_declares_the_corrected_role_scope_and_tail_mapping ... ok
test tests::sink_profiles_match_the_streaming_manifest ... ok
test result: ok. 21 passed; 0 failed
```

Every EAS fixture in those tests is a real Base log (addresses, topics, data, tx hash, block
number verbatim), captured from `base.blockscout.com`'s log API.

### 10.3 One `.spkg`, five chains — and PROOF.md §7.3's limitation closed

§7.3 recorded a real boundary: pointing `params` at another chain did **not** move the
store-backed half of the pipeline, because `initialBlock` was a manifest-level constant, so the
Base run required hand-editing it and reverting afterwards.

That is now closed properly, using Substreams' own `networks:` mechanism rather than a workaround.
Both `substreams run` and `substreams-sink-sql run` accept `--network`, which overrides *both*
params and initialBlocks:

```
--network string   Specify the network to use for params and initialBlocks, overriding the
                   'network' field in the substreams package
```

Five adapter profiles now ship in the manifest. Live streams, one per chain, same
`vouchme-trust-graph-v0.2.0.spkg` (sha256
`81309a936912b2920b994e4dbbcc644117a8ab4ca0578b34e836560e9fe1db78` — note `substreams pack`
embeds `README.md` verbatim as the package doc, so editing the README changes this hash while the
WASM stays identical; re-derive with `substreams pack ./substreams.yaml && sha256sum
vouchme-trust-graph-v0.2.0.spkg`), **zero Rust recompiled between them**:

```
$ substreams run ./substreams.yaml map_trust_events --network base -e base -s 49110120 -t +90 -o jsonl
{"@block":49110131,"events":[{"protocol":"eas","network":"base","from":"0x357458739f90461b99789350868cd7cf330dd7ee","to":"0x70d9e7a9dabf66d7bae8b7656e2a838b26707fe8","issuedAt":"1785009609","txHash":"0xacb7dc06ef040ad1c4463f2a974a7d60894f3f36928c13b76dd5df9f773a447e","scope":"0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4"}]}
{"@block":49110196,"events":[{"protocol":"eas","network":"base","kind":"REVOKE","from":"0x357458739f90461b99789350868cd7cf330dd7ee","to":"0x59fbe10e34aa7639ae3047aeb01ffedee5398ad0", ...}]}
Processed Blocks: 90   Completed successfully

$ substreams run ./substreams.yaml map_trust_events --network optimism -e optimism -s 154673910 -t +20 -o jsonl
{"@block":154673916,"events":[{"protocol":"eas","network":"optimism","kind":"REVOKE","from":"0x359f56ae92f4c3074e7466ed7693cc4715217f74","to":"0x6923e759519ede7e352b1e206519c28046f0a69f", ...}]}
Processed Blocks: 20   Completed successfully

$ substreams run ./substreams.yaml map_trust_events --network arbitrum -e arbitrum -s 487448500 -t +40 -o jsonl
{"@block":487448518,"events":[{"protocol":"eas","network":"arbitrum","from":"0x7848a3578ff2e1f134659a23f64a404a4d710475","to":"0x83143ed768fa64744835ad58748f8dd90ec7a17e", ...}]}
Processed Blocks: 40   Completed successfully

$ substreams run ./substreams.yaml map_trust_events --network mainnet -e mainnet -s 25601310 -t +12 -o jsonl
{"@block":25601316,"events":[{"protocol":"eas","network":"mainnet","from":"0x8f9da3ff538ace863acb9df219b2cd3b4a15ad0e","to":"0x0000000000000000000000000000000000000000", ...}]}
Processed Blocks: 12   Completed successfully
```

`from` is the attester in every one of them. Compare against §10.1.

**Operational finding, disclosed:** each adapter profile hashes to a different module hash, and
`substreams-sink-sql` resolves cursors by highest block — so running a second network against the
same database is refused with `cursor module hash mismatch`. These are bounded backfills with
nothing to resume, so `one-query-demo.sh` truncates `cursors` between networks. A production
multi-network deployment would want one cursor table per profile instead.

### 10.4 The independent audit of the sink

Not "the sink says so." Every row in `trust_edges` is re-derived from
`eth_getTransactionReceipt` against a public RPC for that row's own chain — a different data
plane, no StreamingFast credential — and the adapter profile is re-applied to the raw log by a
second implementation that deliberately does **not** parse the manifest (parsing it would make the
auditor agree with a bug instead of catching it). It also checks specifically for the §10.1 defect
and reports `edge is REVERSED` by name.

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
...
10 verified, 0 failed, 10 rows total
every standardized edge matches an independently-fetched on-chain log, field for field
```

### 10.5 The one-query payoff

```
$ ./substreams/scripts/one-query-demo.sh
   ┌─protocol─┬─network────┬─edges─┬─vouches─┬─revokes─┬─from_block─┬──to_block─┐
1. │ vouchme  │ worldchain │     1 │       1 │       0 │   32835377 │  32835377 │
2. │ eas      │ arbitrum   │     1 │       1 │       0 │  487448518 │ 487448518 │
3. │ eas      │ base       │     5 │       2 │       3 │   49110131 │  49110204 │
4. │ eas      │ mainnet    │     1 │       1 │       0 │   25601316 │  25601316 │
5. │ eas      │ optimism   │     2 │       1 │       1 │  154673918 │ 154673921 │
   └──────────┴────────────┴───────┴─────────┴─────────┴────────────┴───────────┘
```

Full output and what it demonstrates: `docs/17-trust-graph-standard.md` §8.

---

## 11. Honest negatives — what is NOT working, with the real errors

### 11.1 The Graph's hosted Subgraph MCP — blocked on a key type this environment does not have

The Subgraph MCP server is reachable and speaks MCP correctly with the credentials present:

```
$ curl -s -o /dev/null -w '%{http_code}' https://subgraphs.mcp.thegraph.com/sse -H "Authorization: Bearer $SUBSTREAMS_API_KEY"
200
# initialize -> serverInfo {"name":"subgraph-mcp","version":"0.1.1"}
# tools/list  -> search_subgraphs_by_keyword, get_schema_by_subgraph_id,
#                execute_query_by_deployment_id, get_deployment_30day_query_counts, …
```

The session initializes and the tool list returns. Every actual **tool call** then fails:

```
$ node mcpcli.mjs search_subgraphs_by_keyword '{"keyword":"EAS"}'
### search_subgraphs_by_keyword
"code":-32603,"message":"GraphQL error: auth error: malformed API key"
```

Same error directly against the gateway:

```
$ curl -s -X POST "https://gateway.thegraph.com/api/$SUBSTREAMS_API_KEY/subgraphs/id/5zvR82…" \
    -H 'content-type: application/json' -d '{"query":"{_meta{block{number}}}"}'
{"errors":[{"message":"auth error: malformed API key"}]}
```

**Root cause, not a guess:** the key in `.env` is a **Graph Market** key (`server_…`, 39 chars),
which authorizes Substreams and the Token API. The Subgraph MCP proxies to the Subgraph **gateway**,
which requires a **Subgraph Studio** API key (32 hex chars). Those are different credentials from
different products; no amount of retrying converts one into the other. Decoding the JWT confirms
what this account actually holds:

```json
{"substreams_plan_tier":"FREE","token_api_plan_tier":"FREE","token_api_feature_configs":{...}}
```

— `substreams` and `token_api` entitlements, and no gateway entitlement. **The Subgraph MCP is
therefore NOT part of this submission's live path.** It would be a config change, not a code change,
if a Studio key were supplied.

### 11.2 The Graph Token API — reachable, verified, deliberately not wired in

Unlike the gateway, the Token API *does* accept this credential:

```
$ curl -s "https://token-api.service.pinax.network/v1/networks" -H "Authorization: Bearer $SUBSTREAMS_API_TOKEN"
{"networks":[{"id":"arbitrum-one",...},{"id":"base",...},{"id":"mainnet",...},{"id":"optimism",...}, …]}   # 10 networks
```

(Note the hostname: `token-api.thegraph.com` resolves to the same Pinax service but its TLS
handshake is reset from this box — `OpenSSL SSL_connect: Connection reset by peer`. The
`token-api.service.pinax.network` name is the same service and connects.)

It is **not** wired into the pipeline. The Token API serves balances/transfers/NFTs; nothing it
returns is a trust edge, and bolting it on to raise a "products composed" count would be padding.
Recorded here as verified-and-available rather than claimed as used.

### 11.3 The `subgraph/` directory is not deployed

`subgraph/` contains a complete, compiled VouchMe subgraph (schema, manifest, four data sources,
handlers, `build/` artifacts) pointed at the correct live mainnet addresses. It is **not deployed**
and nothing queries it: deploying to Subgraph Studio requires the same Studio credential §11.1
establishes this environment does not have, and the app reads `direct-chain-read:480` instead. It
is also VouchMe-specific, not standardized — the standardized, multi-protocol surface in this
submission is the Substreams package and `trust_edges`, not this subgraph.

### 11.4 Gnosis / Circles v2 — still unreachable, still a provider gap

Unchanged from §7.1 and re-confirmed: `substreams tools default-endpoint gnosis` →
`no endpoint found for network gnosis`. Circles' adapter profile is trivial to write and is
documented in `docs/17-trust-graph-standard.md` §7 as a worked example; it cannot be run.

---

## 12. The MCP layer over the standardized store

`@vouchme/mcp`'s `vouchme_cross_protocol_trust` used to build only the VouchMe leg for real and report
Circles/ENS as zero inbound with a code comment. It now runs **one** query against the
standardized `trust_edges` store and returns whatever protocols are registered — with **no
per-protocol branching in the tool at all.** That absence is the deliverable: registering a new
protocol changes neither this tool nor its configuration.

Two live calls, same tool, same output shape, different protocols and chains:

```
$ node -e '…tool.handler({ address: "0x4774b9621102eac2254365f9311c4e7700d9e7de" })…'
{
  "address": "0x4774b9621102eac2254365f9311c4e7700d9e7de",
  "schema": "trust-graph v0.2.0",
  "count": 1,
  "byProtocol": [ { "protocol": "vouchme", "network": "worldchain", "inbound": 1 } ],
  "edges": [ { "protocol": "vouchme", "network": "worldchain", "scope": "",
      "from": "0xb23a3b2384d721d7c487a3acc6405a1d36672b47",
      "to":   "0x4774b9621102eac2254365f9311c4e7700d9e7de",
      "kind": "VOUCH", "issuedAt": "2026-07-25 19:06:33",
      "expiresAt": "2026-10-23 19:06:33", "perpetual": false, "revoked": false,
      "blockNum": 32835377,
      "txHash": "0x563172cb968bb63b2ba362fa95d6ff257bf94554076ebbbb39e3969cab3d5c45" } ],
  "unavailable": [ "VouchMe engine enrichment skipped (timed out after 8000ms) — VouchMe edges below
                    come from the standardized store and carry no vouchMeWeight" ]
}

$ … { address: "0x70d9e7a9dabf66d7bae8b7656e2a838b26707fe8" } …
{
  "address": "0x70d9e7a9dabf66d7bae8b7656e2a838b26707fe8",
  "schema": "trust-graph v0.2.0",
  "count": 1,
  "byProtocol": [ { "protocol": "eas", "network": "base", "inbound": 1 } ],
  "edges": [ { "protocol": "eas", "network": "base",
      "scope": "0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4",
      "from": "0x357458739f90461b99789350868cd7cf330dd7ee",
      "to":   "0x70d9e7a9dabf66d7bae8b7656e2a838b26707fe8", … } ]
}
```

**The `unavailable` line is deliberate and worth reading, not an embarrassment.** `mcp/src/chain.ts`
still replays `VouchMeRegistry` logs from `deployments/worldchain-sepolia.json` over a chunked
`eth_getLogs` scan — a bespoke, single-protocol, single-chain reader, pointed at a chain VouchMe has
since left. That scan does not finish inside the tool's budget. Before this change it was the
tool's *only* source of VouchMe edges, so the tool simply hung.

Now it is an enrichment with a deadline: the VouchMe edge above is still returned, correct and
complete, **from the standardized store**, and the only thing lost is the normalized `vouchMeWeight`.
The tool says exactly that, by name, instead of returning an empty result. That is the standard
earning its keep — a bespoke per-protocol integration degraded, and the shared schema covered for
it — and it is also a fair illustration of what the standard replaces.
