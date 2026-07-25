//! aval_trust_graph — the composable trust-graph extractor, docs/14-substreams.md §2.
//!
//! `map_trust_events` is generic over ANY contract that emits the trust-graph
//! v0.1.0 event shape: an event with two indexed `address` params (`from`,
//! `to`) whose non-indexed tail is a fixed sequence of ABI words. Which
//! contract, which topic0 belongs to which `Kind`, and which trust model is
//! in effect are all supplied at deploy time via `params` — never compiled
//! in. That is the entire mechanism behind "one `.spkg`, every chain."

mod pb {
    pub mod aval {
        pub mod trust {
            pub mod v1 {
                include!(concat!(env!("OUT_DIR"), "/aval.trust.v1.rs"));
            }
        }
    }
}

use substreams::errors::Error;
use substreams::pb::substreams::store_delta::Operation;
use substreams::store::{DeltaProto, Deltas, StoreNew, StoreSet, StoreSetProto};
use substreams_database_change::pb::sf::substreams::sink::database::v1::DatabaseChanges;
use substreams_database_change::tables::Tables;
use substreams_ethereum::pb::eth::v2 as eth;

use pb::aval::trust::v1::{trust_event::Kind as EventKind, Edge, TrustEvent, TrustEvents};

// ─── params ────────────────────────────────────────────────────────────────

/// Parsed `params.map_trust_events` — the whole per-deployment configuration
/// surface. Everything the module needs to index a *different* contract, on
/// a different chain, for a different platform, lives here — never in code.
#[derive(Debug)]
struct Params {
    contract: [u8; 20],
    vouch_topic: Option<[u8; 32]>,
    revoke_topic: Option<[u8; 32]>,
    reaffirm_topic: Option<[u8; 32]>,
    report_topic: Option<[u8; 32]>,
    report_resolved_topic: Option<[u8; 32]>,
    #[allow(dead_code)] // carried through for provenance / future weight models
    model: String,
    protocol: String,
    network: String,
}

fn strip0x(s: &str) -> &str {
    s.strip_prefix("0x").unwrap_or(s)
}

fn parse_addr(s: &str) -> Result<[u8; 20], Error> {
    let bytes = hex::decode(strip0x(s)).map_err(|e| Error::msg(format!("bad address hex: {e}")))?;
    bytes
        .try_into()
        .map_err(|_| Error::msg("address param must be 20 bytes"))
}

fn parse_topic(s: &str) -> Option<[u8; 32]> {
    if s.is_empty() {
        return None;
    }
    let bytes = hex::decode(strip0x(s)).ok()?;
    bytes.try_into().ok()
}

/// `params` is a URL-query-string, matching docs/14-substreams.md §2's
/// `params.map_trust_events` example verbatim
/// (`contract=0x...&vouch_topic=0x...&...&model=WEIGHTED`).
fn parse_params(raw: &str) -> Result<Params, Error> {
    let mut contract: Option<[u8; 20]> = None;
    let mut vouch_topic = None;
    let mut revoke_topic = None;
    let mut reaffirm_topic = None;
    let mut report_topic = None;
    let mut report_resolved_topic = None;
    let mut model = "WEIGHTED".to_string();
    let mut protocol = "aval".to_string();
    let mut network = String::new();

    for pair in raw.split('&') {
        if pair.is_empty() {
            continue;
        }
        let mut it = pair.splitn(2, '=');
        let key = it.next().unwrap_or("");
        let val = it.next().unwrap_or("");
        match key {
            "contract" => contract = Some(parse_addr(val)?),
            "vouch_topic" => vouch_topic = parse_topic(val),
            "revoke_topic" => revoke_topic = parse_topic(val),
            "reaffirm_topic" => reaffirm_topic = parse_topic(val),
            "report_topic" => report_topic = parse_topic(val),
            "report_resolved_topic" => report_resolved_topic = parse_topic(val),
            "model" => model = val.to_string(),
            "protocol" => protocol = val.to_string(),
            "network" => network = val.to_string(),
            _ => {} // forward-compatible: unknown keys are ignored, not fatal
        }
    }

    let contract = contract.ok_or_else(|| Error::msg("params missing required `contract`"))?;
    if vouch_topic.is_none()
        && revoke_topic.is_none()
        && reaffirm_topic.is_none()
        && report_topic.is_none()
        && report_resolved_topic.is_none()
    {
        return Err(Error::msg(
            "params must set at least one of vouch_topic/revoke_topic/reaffirm_topic/report_topic/report_resolved_topic",
        ));
    }

    Ok(Params {
        contract,
        vouch_topic,
        revoke_topic,
        reaffirm_topic,
        report_topic,
        report_resolved_topic,
        model,
        protocol,
        network,
    })
}

// ─── decoding ──────────────────────────────────────────────────────────────

/// The low 20 bytes of a 32-byte, left-padded ABI address word — this is how
/// an `address indexed` param arrives in `log.topics[1..]`.
fn addr_from_topic(topic: &[u8]) -> Vec<u8> {
    if topic.len() == 32 {
        topic[12..32].to_vec()
    } else {
        topic.to_vec()
    }
}

/// A `uintN` ABI word is always right-aligned in 32 bytes; a `uint64` occupies
/// the low 8.
fn word_u64(word: &[u8]) -> u64 {
    let start = word.len().saturating_sub(8);
    let mut buf = [0u8; 8];
    buf.copy_from_slice(&word[start..]);
    u64::from_be_bytes(buf)
}

/// The trust-graph v0.1.0 event shape fixes indexed params to `(from, to)`
/// but leaves the non-indexed tail free per `Kind`, matching the concrete
/// shapes AvalRegistry actually emits (contracts/src/AvalRegistry.sol):
///   VOUCH    Vouched(address indexed,address indexed,uint64 issuedAt,uint64 expiresAt)   -> 2 words
///   REAFFIRM Reaffirmed(address indexed,address indexed,uint64 expiresAt)                -> 1 word
///   REVOKE / REPORT / REPORT_RESOLVED (..., uint64 at)                                    -> 1 word,
///     read as `issued_at` (the moment the action happened); these kinds carry no expiry.
fn decode_timing(kind: EventKind, data: &[u8]) -> (u64, u64) {
    match kind {
        EventKind::Vouch => {
            if data.len() >= 64 {
                (word_u64(&data[0..32]), word_u64(&data[32..64]))
            } else {
                (0, 0)
            }
        }
        EventKind::Reaffirm => {
            if data.len() >= 32 {
                (0, word_u64(&data[0..32]))
            } else {
                (0, 0)
            }
        }
        EventKind::Revoke | EventKind::Report | EventKind::ReportResolved => {
            if data.len() >= 32 {
                (word_u64(&data[0..32]), 0)
            } else {
                (0, 0)
            }
        }
    }
}

/// `weight_raw` is "protocol-native, unnormalized" (trust_graph.proto doc
/// comment). AvalRegistry's `Vouched` event does not carry a numeric weight —
/// under Aval's WEIGHTED model, a vouch's effective weight depends on the
/// *voucher's own live score* (docs/05-graph-data-layer.md §3.3:
/// `weight = min(score(from)×0.25, 20)/20`), which is graph-wide state, not a
/// per-event fact. The raw extractor therefore emits the protocol-native unit
/// ("1" — one vouch occurred) and leaves score-weighted normalization to the
/// standardized-schema adapter that reads this stream, exactly as
/// docs/05-graph-data-layer.md §3.3 describes the adapter's job to be.
fn default_weight_raw(_model: &str) -> String {
    "1".to_string()
}

fn topic0_matches(topic0: &[u8], expect: &Option<[u8; 32]>) -> bool {
    matches!(expect, Some(t) if t.as_slice() == topic0)
}

// ─── map_trust_events ──────────────────────────────────────────────────────

#[substreams::handlers::map]
fn map_trust_events(params: String, block: eth::Block) -> Result<TrustEvents, Error> {
    let p = parse_params(&params)?;
    let mut events = Vec::new();

    for trx in block.transactions() {
        let tx_hash = trx.hash.clone();

        for (log, _call) in trx.logs_with_calls() {
            if log.address != p.contract {
                continue; // cheapest reject: not our contract
            }
            if log.topics.is_empty() || log.topics.len() < 3 {
                continue; // must have topic0 + two indexed address params
            }

            let topic0 = log.topics[0].as_slice();
            let kind = if topic0_matches(topic0, &p.vouch_topic) {
                EventKind::Vouch
            } else if topic0_matches(topic0, &p.revoke_topic) {
                EventKind::Revoke
            } else if topic0_matches(topic0, &p.reaffirm_topic) {
                EventKind::Reaffirm
            } else if topic0_matches(topic0, &p.report_topic) {
                EventKind::Report
            } else if topic0_matches(topic0, &p.report_resolved_topic) {
                EventKind::ReportResolved
            } else {
                continue; // not one of the configured trust-graph topics
            };

            let from = addr_from_topic(&log.topics[1]);
            let to = addr_from_topic(&log.topics[2]);
            let (issued_at, expires_at) = decode_timing(kind, &log.data);

            events.push(TrustEvent {
                protocol: p.protocol.clone(),
                network: p.network.clone(),
                kind: kind as i32,
                from,
                to,
                weight_raw: default_weight_raw(&p.model),
                issued_at,
                expires_at,
                tx_hash: tx_hash.clone(),
                block_num: block.number,
            });
        }
    }

    Ok(TrustEvents { events })
}

// ─── store_edges ───────────────────────────────────────────────────────────

fn edge_key(protocol: &str, from: &[u8], to: &[u8]) -> String {
    format!("edge:{protocol}:{}:{}", hex::encode(from), hex::encode(to))
}

// KNOWN LIMITATION — read this before changing store_edges:
//
// `updatePolicy: set` stores in Substreams cannot read their own prior state
// from within their own handler. Verified empirically against substreams
// 1.20.2: declaring `store_edges` as its own `mode: get` input (so a REAFFIRM
// or REVOKE event could recover the `weight_raw`/`issued_at` an earlier
// VOUCH wrote for the same key) is rejected by `substreams info` with
// `modules graph has a cycle` — a store module may not depend on itself.
// `StoreSetProto<T>` also has no `get_*` methods at all (confirmed by the
// compiler, not just by convention) — a set-store's own write handle is
// write-only.
//
// So, within the single `store_edges` module docs/14-substreams.md §2 names,
// a REAFFIRM or REVOKE event can only write the fields IT carries; it cannot
// recover `weight_raw` / `issued_at` from an earlier VOUCH for the same key.
// On the live reference deployment this is a *latent* limitation, not an
// active bug: World Chain Sepolia has zero Revoked/Reaffirmed events as of
// this writing (0/0 — see ../PROOF.md and scripts/live-verify.mjs), so every
// Edge this store currently produces is a complete, correct VOUCH record.
//
// The correct fix for when REAFFIRM/REVOKE volume is nonzero is four small
// single-purpose stores combined downstream in `map_edge_deltas` (each using
// an update policy that never needs to read old state):
//   - weight_raw, issued_at: `set`, written only by VOUCH — no history needed
//   - expires_at:            `set`, VOUCH *and* REAFFIRM each supply the full
//                             new value directly — still no history needed
//   - revoked:                `set`, VOUCH implies false / REVOKE implies
//                             true — again the whole value every time
//   - renew_count:            `updatePolicy: add` — Substreams' native
//                             accumulator; the one field that is a true
//                             running total, and the only one that actually
//                             requires cross-event memory
// This still needs no self-referencing store, because each small store is
// read via `mode: get` from a *different*, downstream module — exactly the
// enrichment pattern substreams-ethereum's rpc-and-tokens.md and every store
// consumer in this repo's plugin examples (T2.2, T3.1, T3.2) already use.
#[substreams::handlers::store]
fn store_edges(events: TrustEvents, store: StoreSetProto<Edge>) {
    for (ordinal, ev) in events.events.into_iter().enumerate() {
        let key = edge_key(&ev.protocol, &ev.from, &ev.to);
        let kind = EventKind::try_from(ev.kind).unwrap_or(EventKind::Vouch);

        let mut edge = Edge {
            protocol: ev.protocol.clone(),
            network: ev.network.clone(),
            from: ev.from.clone(),
            to: ev.to.clone(),
            weight_raw: String::new(),
            issued_at: 0,
            expires_at: 0,
            revoked: false,
            renew_count: 0,
            kind: EventKind::Vouch as i32,
            tx_hash: vec![],
            block_num: 0,
        };

        match kind {
            EventKind::Vouch => {
                edge.weight_raw = ev.weight_raw.clone();
                edge.issued_at = ev.issued_at;
                edge.expires_at = ev.expires_at;
                edge.revoked = false;
            }
            EventKind::Reaffirm => {
                edge.expires_at = ev.expires_at;
                // Not a true running total — see the KNOWN LIMITATION note
                // above; this event's `edge` is always freshly zeroed, so
                // this can only ever be 1, not "renewals so far". The doc
                // comment above names `updatePolicy: add` on a dedicated
                // store as the real fix.
                edge.renew_count = 1;
            }
            EventKind::Revoke => {
                edge.revoked = true;
            }
            EventKind::Report | EventKind::ReportResolved => {
                // Reports are signals about an account, not edge mutations —
                // store_edges tracks edges only. A future store_reports would
                // hold these; out of scope for the trust_edges sink table.
                continue;
            }
        }

        edge.kind = kind as i32;
        edge.tx_hash = ev.tx_hash;
        edge.block_num = ev.block_num;

        store.set(ordinal as u64, &key, &edge);
    }
}

// ─── map_edge_deltas — store deltas -> DatabaseChanges (CDC) ──────────────

fn hex0x(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(bytes))
}

#[substreams::handlers::map]
fn map_edge_deltas(deltas: Deltas<DeltaProto<Edge>>) -> Result<DatabaseChanges, Error> {
    let mut tables = Tables::new();

    for delta in deltas.deltas {
        let edge = &delta.new_value;
        let kind = EventKind::try_from(edge.kind).unwrap_or(EventKind::Vouch);
        let key = [
            ("protocol", edge.protocol.as_str()),
            ("to_addr", &hex0x(&edge.to)),
            ("from_addr", &hex0x(&edge.from)),
        ];

        match delta.operation {
            Operation::Delete => {
                tables.delete_row("trust_edges", key);
            }
            _ => {
                // Create and Update behave identically here: ClickHouse
                // Database Changes is insert-only (substreams-sql skill,
                // "Capability matrix") — every write is a new row for the
                // schema.sql ReplacingMergeTree(block_num) key to dedupe on
                // read via `FINAL` (schema.sql doc comment).
                tables
                    .create_row("trust_edges", key)
                    .set("network", edge.network.as_str())
                    .set("kind", kind.as_str_name())
                    .set("weight_raw", edge.weight_raw.as_str())
                    .set("issued_at", edge.issued_at as i64)
                    .set("expires_at", edge.expires_at as i64)
                    .set("revoked", if edge.revoked { 1u32 } else { 0u32 })
                    .set("block_num", edge.block_num as i64)
                    .set("tx_hash", hex0x(&edge.tx_hash));
            }
        }
    }

    Ok(tables.to_database_changes())
}

// ─── db_out — stable-name sink target (docs/14 §2 module graph) ──────────

#[substreams::handlers::map]
fn db_out(changes: DatabaseChanges) -> Result<DatabaseChanges, Error> {
    Ok(changes)
}

// ─── tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use substreams::testing;
    use substreams_ethereum::pb::eth::v2::{
        Block, BlockHeader, Call, Log, TransactionReceipt, TransactionTrace,
    };

    // Real params for the live deployment, deployments/worldchain-sepolia.json.
    const REAL_PARAMS: &str = "contract=0x1d9955cb9f2a531fa6d4f43e712c9b1fa9a44514&vouch_topic=0x1023f6bd7654e275f0ff5868480691e3f5feb9960e997af34f0cf9e4b33e22b9&revoke_topic=0xb1c57350b08a198ff1a7862eeb3246e35fa3fc8e954bc691997ce37da018cbc7&reaffirm_topic=0x9089bae040c16337c6e96ac1661dba8c85c8b076f44d68407b4fa00243c05db7&report_topic=&report_resolved_topic=&model=WEIGHTED&protocol=aval&network=worldchain-sepolia";

    fn hex_bytes(s: &str) -> Vec<u8> {
        hex::decode(s.strip_prefix("0x").unwrap_or(s)).unwrap()
    }

    /// Builds a `Block` carrying exactly one real log, captured live from
    /// World Chain Sepolia via `eth_getLogs` against the deployed
    /// AvalRegistry (0x1d9955...4514) — see ../PROOF.md for the raw RPC
    /// response and how it was captured. This is the same shape
    /// `substreams-testing`'s "Constructing Ethereum blocks" pattern uses.
    fn block_with_real_log(
        block_number: u64,
        tx_hash_hex: &str,
        log_address_hex: &str,
        topics_hex: &[&str],
        data_hex: &str,
    ) -> Block {
        Block {
            number: block_number,
            header: Some(BlockHeader {
                ..Default::default()
            }),
            transaction_traces: vec![TransactionTrace {
                hash: hex_bytes(tx_hash_hex),
                status: 1, // SUCCEEDED — required for block.transactions() to include it
                receipt: Some(TransactionReceipt {
                    logs: vec![Log {
                        address: hex_bytes(log_address_hex),
                        topics: topics_hex.iter().map(|t| hex_bytes(t)).collect(),
                        data: hex_bytes(data_hex),
                        ..Default::default()
                    }],
                    ..Default::default()
                }),
                // `map_trust_events` reads logs via `trx.logs_with_calls()`, which — per
                // substreams-ethereum-core's `block_view.rs` — iterates `TransactionTrace.calls[].logs`,
                // NOT `receipt.logs` (the receipt copy is what a real Firehose block also carries, but
                // `logs_with_calls()` ignores it; it exists to exclude logs from reverted sub-calls, so
                // it reads off `calls`). A fixture with only `receipt.logs` set decodes to zero events
                // — silently, no panic — which is exactly the "builds but decodes nothing" failure mode
                // the acceptance test exists to catch. Caught by actually running `cargo test`, not by
                // inspection: the two tests below failed (0 events, not 1) until this call was added.
                calls: vec![Call {
                    state_reverted: false,
                    logs: vec![Log {
                        address: hex_bytes(log_address_hex),
                        topics: topics_hex.iter().map(|t| hex_bytes(t)).collect(),
                        data: hex_bytes(data_hex),
                        ..Default::default()
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    /// Real `Vouched` log, block 32216398 (0x1eb954e), tx
    /// 0x4e3f68550eb01521d73ab56ac5663d12f7f43a7eb26e990ccc329e4127c6465b:
    /// anchor1 (0xdefbe7d7...ee0780) vouches for 0xee0f520a...40520b, a
    /// 90-day expiry (1784980220 -> 1792756220), fetched live via
    /// `eth_getLogs` on 2026-07-25 — see ../PROOF.md.
    #[test]
    fn decodes_real_vouched_event() {
        let block = block_with_real_log(
            32216398,
            "0x4e3f68550eb01521d73ab56ac5663d12f7f43a7eb26e990ccc329e4127c6465b",
            "0x1d9955cb9f2a531fa6d4f43e712c9b1fa9a44514",
            &[
                "0x1023f6bd7654e275f0ff5868480691e3f5feb9960e997af34f0cf9e4b33e22b9",
                "0x000000000000000000000000defbe7d71f0eae651399c0fb97cf93fa09ee0780",
                "0x000000000000000000000000ee0f520a7cd3f6998dee6463dfe3fc49e040520b",
            ],
            "0x000000000000000000000000000000000000000000000000000000006a64a2fc000000000000000000000000000000000000000000000000000000006adb49fc",
        );

        let out = testing::map!(map_trust_events(REAL_PARAMS.to_string(), block)).unwrap();

        assert_eq!(out.events.len(), 1, "expected exactly one decoded TrustEvent");
        let ev = &out.events[0];
        assert_eq!(ev.kind, EventKind::Vouch as i32);
        assert_eq!(ev.protocol, "aval");
        assert_eq!(ev.network, "worldchain-sepolia");
        assert_eq!(hex::encode(&ev.from), "defbe7d71f0eae651399c0fb97cf93fa09ee0780");
        assert_eq!(hex::encode(&ev.to), "ee0f520a7cd3f6998dee6463dfe3fc49e040520b");
        assert_eq!(ev.issued_at, 1784980220);
        assert_eq!(ev.expires_at, 1792756220);
        assert_eq!(ev.expires_at - ev.issued_at, 90 * 86400, "Aval vouches expire after 90 days");
        assert_eq!(ev.weight_raw, "1");
        assert_eq!(ev.block_num, 32216398);
        assert_eq!(
            hex::encode(&ev.tx_hash),
            "4e3f68550eb01521d73ab56ac5663d12f7f43a7eb26e990ccc329e4127c6465b"
        );
    }

    /// Two more real `Vouched` logs from the same live scan (anchor2 and
    /// anchor3 vouching), proving the decode is not a single-fixture fluke.
    #[test]
    fn decodes_two_more_real_vouched_events() {
        let block_a = block_with_real_log(
            32216399,
            "0x0c7ca8836d46e2300dbea056b87080dfb198205c3d3ba903bfe05cb69436f3f2",
            "0x1d9955cb9f2a531fa6d4f43e712c9b1fa9a44514",
            &[
                "0x1023f6bd7654e275f0ff5868480691e3f5feb9960e997af34f0cf9e4b33e22b9",
                "0x00000000000000000000000025ae26af3dd85a3b91934723a50820ed1eb1777b",
                "0x000000000000000000000000ee0f520a7cd3f6998dee6463dfe3fc49e040520b",
            ],
            "0x000000000000000000000000000000000000000000000000000000006a64a2fe000000000000000000000000000000000000000000000000000000006adb49fe",
        );
        let out_a = testing::map!(map_trust_events(REAL_PARAMS.to_string(), block_a)).unwrap();
        assert_eq!(out_a.events.len(), 1);
        assert_eq!(hex::encode(&out_a.events[0].from), "25ae26af3dd85a3b91934723a50820ed1eb1777b");

        let block_b = block_with_real_log(
            32216401,
            "0xe156704107e41cf8edf3e020dc26a18d30b081d11ef22fc4b8e8d6e21636f45c",
            "0x1d9955cb9f2a531fa6d4f43e712c9b1fa9a44514",
            &[
                "0x1023f6bd7654e275f0ff5868480691e3f5feb9960e997af34f0cf9e4b33e22b9",
                "0x000000000000000000000000646fbae1773218ad34ebacc8a161c34fa7c7ec2c",
                "0x0000000000000000000000004dfc0607d1687816eea7df62847a953a29272777",
            ],
            "0x000000000000000000000000000000000000000000000000000000006a64a302000000000000000000000000000000000000000000000000000000006adb4a02",
        );
        let out_b = testing::map!(map_trust_events(REAL_PARAMS.to_string(), block_b)).unwrap();
        assert_eq!(out_b.events.len(), 1);
        assert_eq!(hex::encode(&out_b.events[0].from), "646fbae1773218ad34ebacc8a161c34fa7c7ec2c");
        assert_eq!(hex::encode(&out_b.events[0].to), "4dfc0607d1687816eea7df62847a953a29272777");
    }

    /// A block with no matching logs decodes to zero events — the module
    /// must not fabricate data, and must not choke on an empty block.
    #[test]
    fn empty_block_decodes_to_no_events() {
        let out = testing::map!(map_trust_events(REAL_PARAMS.to_string(), Block::default())).unwrap();
        assert!(out.events.is_empty());
    }

    /// A log from a different contract address must be ignored even if the
    /// topic0 matches — the cheapest-reject address filter must run first.
    #[test]
    fn ignores_logs_from_other_contracts() {
        let block = block_with_real_log(
            32216398,
            "0x4e3f68550eb01521d73ab56ac5663d12f7f43a7eb26e990ccc329e4127c6465b",
            "0x0000000000000000000000000000000000dead", // not AvalRegistry
            &[
                "0x1023f6bd7654e275f0ff5868480691e3f5feb9960e997af34f0cf9e4b33e22b9",
                "0x000000000000000000000000defbe7d71f0eae651399c0fb97cf93fa09ee0780",
                "0x000000000000000000000000ee0f520a7cd3f6998dee6463dfe3fc49e040520b",
            ],
            "0x000000000000000000000000000000000000000000000000000000006a64a2fc000000000000000000000000000000000000000000000000000000006adb49fc",
        );
        let out = testing::map!(map_trust_events(REAL_PARAMS.to_string(), block)).unwrap();
        assert!(out.events.is_empty());
    }

    #[test]
    fn parse_params_rejects_missing_contract() {
        let err = parse_params("vouch_topic=0xaa&model=WEIGHTED").unwrap_err();
        assert!(err.to_string().contains("contract"));
    }

    #[test]
    fn parse_params_rejects_no_topics() {
        let err = parse_params("contract=0x1d9955cb9f2a531fa6d4f43e712c9b1fa9a44514").unwrap_err();
        assert!(err.to_string().contains("topic"));
    }

    /// Same decode primitives (indexed-address-from-topic, ABI word
    /// decoding), applied to a real `Enrolled` log — block 32216383
    /// (0x1eb953f), tx
    /// 0xe988ee338cba2dac86d2e4156958ae6d53f4c42cca7ee43abd8f83c2a39ea4be.
    /// `Enrolled` is NOT part of trust_graph.proto's `Kind` enum (enrollment
    /// creates an account, it is not an edge — docs/14 §2's Kind is
    /// VOUCH/REVOKE/REAFFIRM/REPORT/REPORT_RESOLVED only), so it is not
    /// wired into `map_trust_events`'s output. This test exists purely to
    /// prove — against real on-chain bytes — that the same ABI-decoding
    /// primitives this module relies on (address-from-topic, uint64-from-word,
    /// and here, the dynamic `string` tail) work correctly, satisfying the
    /// "show actual decoded Vouched/Enrolled events" acceptance bar. See
    /// ../PROOF.md for the full worked decode and the raw log.
    #[test]
    fn decodes_real_enrolled_event_as_account_context() {
        let topics = [
            hex_bytes("0x000000000000000000000000defbe7d71f0eae651399c0fb97cf93fa09ee0780"), // account
            hex_bytes("0xa79cb55561cb5780eb295a334f8aabc3bae9b45f28c19600c73370ca35bae47a"), // nullifierHash
        ];
        let data = hex_bytes(
            "0x24724ee4262a299f5a9688e2fbc2a10ebcf5d2f3784ae745497cb764389a34a5\
              000000000000000000000000000000000000000000000000000000006adb49de\
              0000000000000000000000000000000000000000000000000000000000000060\
              0000000000000000000000000000000000000000000000000000000000000010\
              616e63686f72312e6176616c2e657468000000000000000000000000000000",
        );

        let account = addr_from_topic(&topics[0]);
        assert_eq!(hex::encode(&account), "defbe7d71f0eae651399c0fb97cf93fa09ee0780");

        let credential_expires_at = word_u64(&data[32..64]);
        assert_eq!(credential_expires_at, 1792756190);

        // Dynamic `string handle` tail: word[2] is the byte offset to the
        // tail (from the start of `data`), the word at that offset is the
        // string length, followed by the UTF-8 bytes.
        let str_offset = word_u64(&data[64..96]) as usize;
        let str_len = word_u64(&data[str_offset..str_offset + 32]) as usize;
        let handle_bytes = &data[str_offset + 32..str_offset + 32 + str_len];
        let handle = std::str::from_utf8(handle_bytes).unwrap();
        assert_eq!(handle, "anchor1.aval.eth");
    }
}
