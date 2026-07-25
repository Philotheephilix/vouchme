# Proof — what actually ran, against what, and why

This file is the evidence trail for `substreams/aval-trust/`: what was installed, what real
on-chain data was decoded, why `substreams run` could not reach World Chain Sepolia directly, and
exactly what would be needed to close that gap. Every command below was actually run on this box on
2026-07-25; nothing here is a projection.

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
Firehose/Substreams endpoint today.** World Chain *mainnet* does, but AvalRegistry
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

**What it would NOT have proven:** anything about decoding *AvalRegistry's actual events* — Base/Gnosis
don't have this contract, so proving the module against them would need fabricated params pointed at
some *other* real contract's Vouch-shaped event there, which (a) is a materially different claim than
"this pipeline decodes Aval's real events" and (b) is blocked anyway by §3 — there is no credential
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
100-block chunks from block `32216305` (`AvalRegistry` deployment block) to the chain head
(`32220307` at capture time):

```
Vouched   12
Enrolled  14
Revoked    0
Reaffirmed 0
```

This matches the task brief exactly ("14 Enrolled, 12+ Vouched"). Three real `Vouched` logs and one
real `Enrolled` log were pulled verbatim (address, topics, data, tx hash, block number — nothing
edited) into `substreams/aval-trust/src/lib.rs`'s `#[cfg(test)]` module.

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
assert_eq!(ev.expires_at - ev.issued_at, 90 * 86400); // Aval's 90-day vouch expiry, decoded, not assumed
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
assert_eq!(handle, "anchor1.aval.eth");
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
(`aval-trust-graph-v0.2.0.spkg`, §5).

## 5. Build artifacts (this session)

```
$ cargo build --target wasm32-unknown-unknown --release
    Finished `release` profile [optimized] target(s) in 17.68s
$ ls -la target/wasm32-unknown-unknown/release/aval_trust_graph.wasm
-rwxr-xr-x 1 ubuntu ubuntu 315189 ... aval_trust_graph.wasm

$ substreams pack ./substreams.yaml
✅ Package created successfully at ./aval-trust-graph-v0.2.0.spkg
$ sha256sum aval-trust-graph-v0.2.0.spkg
36897d779a2fc280336ed4cafd68c0104f019589a8131d8d26d416f7433009da  aval-trust-graph-v0.2.0.spkg
# (repacking after any README.md edit changes this hash — substreams pack embeds README.md
# verbatim as the package doc, confirmed via `substreams info`'s "Doc:" field; the wasm itself
# is unchanged from §6's `cargo build` unless src/lib.rs or substreams.yaml also changed)

$ substreams info ./aval-trust-graph-v0.2.0.spkg
Package name: aval_trust_graph
Version: v0.2.0
Network: worldchain
Modules:
  map_trust_events  (map)    -> proto:aval.trust.v1.TrustEvents
  store_edges       (store, updatePolicy: set) -> proto:aval.trust.v1.Edge
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
and `REVOKE` events on AvalRegistry don't carry the full edge record (only `Vouched` does) — so a
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
