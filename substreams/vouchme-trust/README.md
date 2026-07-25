# vouchme_trust_graph

**A composable Substreams package implementing the Trust Graph Standard v0.2.0** — one shared
schema for a protocol category that had none.

Trust and attestation protocols all express the same primitive — *account A asserts something
about account B, at a time, revocably* — and every one models it differently. This package is the
executable form of a standard for that shape. One `.spkg`, parameterized rather than forked: the
same WASM binary indexes **any** contract emitting an asserter/subject event pair, with the
per-protocol mapping supplied as declarative config rather than code.

**The standard itself is specified in `docs/17-trust-graph-standard.md`.** Read that first; this
file is the operator's guide.

## Overview

Decodes `VOUCH` / `REVOKE` / `REAFFIRM` / `REPORT` / `REPORT_RESOLVED` events into a standardized
`TrustEvent`, accumulates live edge state, and emits `DatabaseChanges` for a ClickHouse
`trust_edges` table (`schema.sql`) — also the read path for the BFS trust engine
(docs/05-graph-data-layer.md §2.2 / §3.2, docs/14-substreams.md §4). See `../PROOF.md` for the live
runs, the independent cross-checks, and an honest account of what does not work.

## Live coverage

Two protocols, five chains, one binary — **no Rust differs between them**, only a `networks:`
entry:

| Protocol | Network | Contract | Roles | Scope | Tails |
|---|---|---|---|---|---|
| `vouchme` | `worldchain` | `0x6fEfEf2d44203300a6a33d631840C972181b8722` | `from=1, to=2` | — | `vouch=issued_expires`, `revoke=at`, `reaffirm=expires` |
| `eas` | `base` | `0x4200000000000000000000000000000000000021` | `from=2, to=1` | `3` | `vouch=none`, `revoke=none` |
| `eas` | `optimism` | `0x4200000000000000000000000000000000000021` | `from=2, to=1` | `3` | `vouch=none`, `revoke=none` |
| `eas` | `arbitrum` | `0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458` | `from=2, to=1` | `3` | `vouch=none`, `revoke=none` |
| `eas` | `mainnet` | `0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587` | `from=2, to=1` | `3` | `vouch=none`, `revoke=none` |

The `from`/`to` column is the point of the whole exercise: VouchMe declares its indexed params
asserter-first, EAS declares them subject-first. Both are two indexed addresses, and both decode
without error under either reading — only the declared profile tells them apart. Getting it wrong
reverses every edge while producing entirely plausible output. `../PROOF.md` §10.1 has the real
rows that were wrong before this was made explicit.

## Modules

| Module | Kind | Output | Description |
|---|---|---|---|
| `map_trust_events` | map | `proto:vouchme.trust.v1.TrustEvents` | Raw block → standardized trust events, decoded per the adapter profile in `params` |
| `store_edges` | store (`set`) | `proto:vouchme.trust.v1.Edge` | Accumulated live state, keyed `(protocol, network, scope, from, to)` |
| `map_edge_deltas` | map | `proto:sf.substreams.sink.database.v1.DatabaseChanges` | Store deltas → CDC rows for `trust_edges` |
| `db_out` | map | `proto:sf.substreams.sink.database.v1.DatabaseChanges` | Stable-name sink target (passthrough of `map_edge_deltas`) |

## Prerequisites

- Rust + `wasm32-unknown-unknown` target, `substreams` CLI, `protoc` (exact versions in `../PROOF.md` §1)
- `SUBSTREAMS_API_KEY` / `SUBSTREAMS_API_TOKEN` in the repo-root `.env`
- A Substreams endpoint for the target chain: `substreams tools default-endpoint <network>`.
  **Gnosis has none**, which is why Circles v2 is specified but not indexed (`../PROOF.md` §11.4).

## Quick start

```bash
node ../scripts/fetch-fixtures.mjs                   # optional: re-pull real logs (reproduces src/lib.rs fixtures)
cargo test                                           # 21 tests, all against real captured logs, no network
cargo build --target wasm32-unknown-unknown --release
substreams pack ./substreams.yaml                    # -> vouchme-trust-graph-v0.2.0.spkg

# Stream any registered profile. The ONLY thing that changes is --network / -e.
substreams run ./substreams.yaml map_trust_events --network worldchain -e worldchain -s 32835370 -t +20 -o jsonl
substreams run ./substreams.yaml map_trust_events --network base       -e base       -s 49110120 -t +90 -o jsonl
```

## Sink to SQL, then query every protocol at once

```bash
DSN="clickhouse://default:@localhost:9000/default"
substreams-sink-sql setup "$DSN" ./substreams.sink.yaml
substreams-sink-sql run   "$DSN" ./substreams.sink.yaml 49110120:49110210 \
  --network base -e base --undo-buffer-size=1 --development-mode --batch-block-flush-interval=1
```

Then the payoff — one query that names no protocol and no chain:

```bash
../scripts/one-query-demo.sh                # --reindex re-runs all five live streams first
node ../scripts/crosscheck-trust-edges.mjs  # independently verify every row against public RPCs
```

**Two manifests, deliberately.** `substreams.yaml` is the primary artifact and the one that
streams. `substreams.sink.yaml` adds the single protobuf import `substreams-sink-sql` requires,
which `substreams run` cannot tolerate — both files document the exact tool incompatibility
inline. The five adapter profiles are duplicated across them because importing a package
namespaces its module names; the test `sink_profiles_match_the_streaming_manifest` fails the build
if they drift.

## Adding a protocol

No code. Add a `networks:` entry to both manifests. The checklist — including how to determine role
order, scope and tail layout without guessing — is `docs/17-trust-graph-standard.md` §7, with
Circles v2 worked through as an example. `skills/vouchme-substreams-deploy` automates the mechanical
part.

## Reuse

This is a normal, importable `.spkg`; nothing about it is VouchMe-specific at runtime — VouchMe is simply
its first registered profile.

```yaml
imports:
  trust: https://github.com/vouchme-protocol/vouchme/releases/download/v0.2.0/vouchme-trust-graph-v0.2.0.spkg

modules:
  - name: my_module
    inputs:
      - map: trust:map_trust_events   # standardized TrustEvents, any registered protocol
```
