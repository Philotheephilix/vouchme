# aval_trust_graph

Composable trust-graph extractor for Aval. One `.spkg`, parameterized rather than forked — the same
binary indexes **any** contract that emits the trust-graph v0.1.0 event shape (docs/14-substreams.md
§2): an event with two `indexed address` params (`from`, `to`) and a fixed non-indexed tail.

## Overview

Decodes `VOUCH` / `REVOKE` / `REAFFIRM` / `REPORT` / `REPORT_RESOLVED` events into a standardized
`TrustEvent`, accumulates live edge state, and emits `DatabaseChanges` for a ClickHouse
`trust_edges` table (`schema.sql`) — the read path for the BFS trust engine
(docs/05-graph-data-layer.md §2.2 / §3.2, docs/14-substreams.md §4). Reference deployment: World
Chain Sepolia (chainId 4801), `AvalRegistry` `0x1d9955CB9f2A531fa6D4f43E712c9B1Fa9A44514`, from block
`32216305` (`../../deployments/worldchain-sepolia.json`). See `../PROOF.md` for the decode proof
against real on-chain data and exactly what could and could not be run live, and why.

## Modules

| Module | Kind | Output | Description |
|---|---|---|---|
| `map_trust_events` | map | `proto:aval.trust.v1.TrustEvents` | Raw block → standardized trust events, filtered/decoded per `params` (contract, topic0s, model) |
| `store_edges` | store (`set`) | `proto:aval.trust.v1.Edge` | Accumulated live state of every `(protocol, from, to)` edge |
| `map_edge_deltas` | map | `proto:sf.substreams.sink.database.v1.DatabaseChanges` | Store deltas → CDC rows for `trust_edges` |
| `db_out` | map | `proto:sf.substreams.sink.database.v1.DatabaseChanges` | Stable-name sink target (passthrough of `map_edge_deltas`) |

## Prerequisites

- Rust + `wasm32-unknown-unknown` target, `substreams` CLI (see `../PROOF.md` for exact versions used)
- `protoc` (protobuf compiler)
- A Substreams/Firehose endpoint for the target chain — **World Chain Sepolia has none as of
  2026-07-25** (not in StreamingFast's network registry); see `../PROOF.md`.

## Quick start

```bash
node ../scripts/fetch-fixtures.mjs                  # optional: re-pull real logs from RPC (reproduces src/lib.rs's fixtures)
cargo test                                          # decode proof against real captured logs (no network)
cargo build --target wasm32-unknown-unknown --release
substreams pack ./substreams.yaml                   # -> aval_trust_graph-v0.2.0.spkg

# Against a chain WITH a registered endpoint (params re-pointed at that chain's contract):
substreams run ./substreams.yaml map_trust_events -e <network> -s <start_block> -t +1000 -o jsonl
```

## Reusing this package for a different chain / contract

Change `params.map_trust_events` only — never the Rust, never the manifest's `modules:` — per
docs/14-substreams.md §2's "one `.spkg`, every chain" design and the `skills/aval-substreams-deploy`
SKILL that automates exactly this substitution.
