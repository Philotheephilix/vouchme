//! vouchme_trust_graph — the composable trust-graph extractor, docs/14-substreams.md §2.
//!
//! `map_trust_events` is generic over ANY contract that emits the trust-graph
//! v0.1.0 event shape: an event with two indexed `address` params (`from`,
//! `to`) whose non-indexed tail is a fixed sequence of ABI words. Which
//! contract, which topic0 belongs to which `Kind`, and which trust model is
//! in effect are all supplied at deploy time via `params` — never compiled
//! in. That is the entire mechanism behind "one `.spkg`, every chain."

mod pb {
    pub mod vouchme {
        pub mod trust {
            pub mod v1 {
                include!(concat!(env!("OUT_DIR"), "/vouchme.trust.v1.rs"));
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

use pb::vouchme::trust::v1::{trust_event::Kind as EventKind, Edge, TrustEvent, TrustEvents};

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
    /// Which indexed topic carries the ASSERTER (`from`) and which the SUBJECT (`to`), as 1-based
    /// topic indices.
    ///
    /// Two indexed address params do not mean the same two things in every protocol. VouchMe declares
    /// them asserter-first (`Vouched(address indexed voucher, address indexed vouchee, ...)`);
    /// **EAS does not** — `Attested(address indexed recipient, address indexed attester, bytes32,
    /// bytes32 indexed)` puts the SUBJECT first, so inferring the roles from position alone points
    /// every EAS edge backwards. There is no ABI-level signal that distinguishes the two orderings,
    /// so the mapping is declared per deployment. Defaults (1, 2) are asserter-first.
    from_topic: usize,
    to_topic: usize,
    /// Optional 1-based topic index carrying the `scope` discriminator (EAS: `schemaUID` at
    /// topics[3]). `None` -> scope is the empty string. See trust_graph.proto's `scope` doc.
    scope_topic: Option<usize>,
    /// Per-kind layout of the NON-INDEXED event tail. See `TailLayout`.
    vouch_tail: TailLayout,
    revoke_tail: TailLayout,
    reaffirm_tail: TailLayout,
    report_tail: TailLayout,
    report_resolved_tail: TailLayout,
}

/// How to read a kind's non-indexed ABI tail for timing information.
///
/// The layout cannot be inferred from `Kind` alone: "VOUCH means two uint64 words, issuedAt then
/// expiresAt" holds only for contracts shaped like VouchMeRegistry. EAS's single non-indexed word is
/// a content-addressed `uid`, and reading a hash as a clock yields absurd expiries. A deployment
/// therefore DECLARES its tail layout, and `None` is a first-class answer meaning "this log
/// carries no timing data; use the block clock and leave expiry unset".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TailLayout {
    /// word[0] = issuedAt, word[1] = expiresAt  (VouchMeRegistry `Vouched`)
    IssuedExpires,
    /// word[0] = expiresAt; issuedAt falls back to the block clock (VouchMeRegistry `Reaffirmed`)
    Expires,
    /// word[0] = the moment the action happened, read as issuedAt (VouchMeRegistry `Revoked`)
    At,
    /// No timing data in the log at all. issuedAt = block clock, expiresAt = 0 (= perpetual as
    /// far as THIS log can prove). EAS `Attested` / `Revoked`, whose tail is a `uid`.
    None,
}

impl TailLayout {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "issued_expires" => Some(Self::IssuedExpires),
            "expires" => Some(Self::Expires),
            "at" => Some(Self::At),
            "none" => Some(Self::None),
            _ => None,
        }
    }
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
    let mut protocol = "vouchme".to_string();
    let mut network = String::new();
    // Defaults reproduce trust-graph v0.1.0's implicit behaviour, so a deployment written against
    // v0.1.0 keeps its meaning without editing its params.
    let mut from_topic = 1usize;
    let mut to_topic = 2usize;
    let mut scope_topic: Option<usize> = None;
    let mut vouch_tail = TailLayout::IssuedExpires;
    let mut revoke_tail = TailLayout::At;
    let mut reaffirm_tail = TailLayout::Expires;
    let mut report_tail = TailLayout::At;
    let mut report_resolved_tail = TailLayout::At;

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
            "from_topic" => {
                from_topic = val
                    .parse()
                    .map_err(|_| Error::msg(format!("from_topic must be a topic index, got {val:?}")))?
            }
            "to_topic" => {
                to_topic = val
                    .parse()
                    .map_err(|_| Error::msg(format!("to_topic must be a topic index, got {val:?}")))?
            }
            "scope_topic" => {
                scope_topic = if val.is_empty() {
                    None
                } else {
                    Some(val.parse().map_err(|_| {
                        Error::msg(format!("scope_topic must be a topic index, got {val:?}"))
                    })?)
                }
            }
            // An UNRECOGNISED tail value is fatal, not silently defaulted: a typo like
            // `vouch_tail=nil` would otherwise fall back to reading a `uid` as a timestamp.
            "vouch_tail" => {
                vouch_tail = TailLayout::parse(val)
                    .ok_or_else(|| Error::msg(format!("unknown vouch_tail {val:?}")))?
            }
            "revoke_tail" => {
                revoke_tail = TailLayout::parse(val)
                    .ok_or_else(|| Error::msg(format!("unknown revoke_tail {val:?}")))?
            }
            "reaffirm_tail" => {
                reaffirm_tail = TailLayout::parse(val)
                    .ok_or_else(|| Error::msg(format!("unknown reaffirm_tail {val:?}")))?
            }
            "report_tail" => {
                report_tail = TailLayout::parse(val)
                    .ok_or_else(|| Error::msg(format!("unknown report_tail {val:?}")))?
            }
            "report_resolved_tail" => {
                report_resolved_tail = TailLayout::parse(val)
                    .ok_or_else(|| Error::msg(format!("unknown report_resolved_tail {val:?}")))?
            }
            _ => {} // forward-compatible: unknown keys are ignored, not fatal
        }
    }

    if from_topic == 0 || to_topic == 0 {
        return Err(Error::msg("from_topic/to_topic are 1-based topic indices; 0 is topic0"));
    }
    if from_topic == to_topic {
        return Err(Error::msg("from_topic and to_topic must differ"));
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
        from_topic,
        to_topic,
        scope_topic,
        vouch_tail,
        revoke_tail,
        reaffirm_tail,
        report_tail,
        report_resolved_tail,
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

/// Decodes `(issued_at, expires_at)` from a log's non-indexed tail, per the declared `TailLayout`.
///
/// The trust-graph event shape fixes indexed params to `(from, to)` but leaves the non-indexed
/// tail free per `Kind`, matching the concrete shapes VouchMeRegistry actually emits
/// (contracts/src/VouchMeRegistry.sol):
///   VOUCH    Vouched(address indexed,address indexed,uint64 issuedAt,uint64 expiresAt)   -> 2 words
///   REAFFIRM Reaffirmed(address indexed,address indexed,uint64 expiresAt)                -> 1 word
///   REVOKE / REPORT / REPORT_RESOLVED (..., uint64 at)                                    -> 1 word,
///     read as `issued_at` (the moment the action happened); these kinds carry no expiry.
///
/// `block_timestamp` (the containing block's own clock, always present, never decoded from event
/// data) is the fallback `issued_at` for every kind whose ABI shape does not carry an explicit
/// issuance word — REAFFIRM has none at all (only `expiresAt`), and neither do the too-short-data
/// branches. It must never fall back to `0` instead: `issued_at: 0` is literal Unix epoch,
/// 1970-01-01, which any downstream tenure/freshness computation reads as maximally old. The block
/// clock is always at least "this event genuinely happened at this real, on-chain moment". It does
/// not, by itself, recover an *original* VOUCH's `issued_at` when a REAFFIRM follows it — that gap
/// is the separate `store_edges` KNOWN LIMITATION below.
fn decode_timing(layout: TailLayout, data: &[u8], block_timestamp: u64) -> (u64, u64) {
    match layout {
        TailLayout::IssuedExpires => {
            if data.len() >= 64 {
                (word_u64(&data[0..32]), word_u64(&data[32..64]))
            } else {
                (block_timestamp, 0)
            }
        }
        TailLayout::Expires => {
            if data.len() >= 32 {
                (block_timestamp, word_u64(&data[0..32]))
            } else {
                (block_timestamp, 0)
            }
        }
        TailLayout::At => {
            if data.len() >= 32 {
                (word_u64(&data[0..32]), 0)
            } else {
                (block_timestamp, 0)
            }
        }
        // A deployment declaring "there is no timing data here" gets the block clock plus an
        // explicit `expires_at = 0` (perpetual as far as this log proves), rather than a `uid`
        // hash silently decoded as a year-2106 expiry.
        TailLayout::None => (block_timestamp, 0),
    }
}

/// `weight_raw` is "protocol-native, unnormalized" (trust_graph.proto doc
/// comment). VouchMeRegistry's `Vouched` event does not carry a numeric weight —
/// under VouchMe's WEIGHTED model, a vouch's effective weight depends on the
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
    // Available on every block, real, never decoded/guessed from event data — the fallback
    // `issued_at` source for event kinds whose ABI shape carries no issuance word of their own.
    // `Block::default()` (used by the empty-block test) has no `header`, so guard rather than
    // unwrap: `timestamp_seconds()` panics on a missing header, which a real Firehose block never
    // has, but a synthetic test block might.
    let block_timestamp = block
        .header
        .as_ref()
        .and_then(|h| h.timestamp.as_ref())
        .map(|t| t.seconds as u64)
        .unwrap_or(0);

    for trx in block.transactions() {
        let tx_hash = trx.hash.clone();

        for (log, _call) in trx.logs_with_calls() {
            if log.address != p.contract {
                continue; // cheapest reject: not our contract
            }
            if log.topics.is_empty() {
                continue; // not even a topic0 — anonymous event, never ours
            }

            let topic0 = log.topics[0].as_slice();
            let (kind, tail) = if topic0_matches(topic0, &p.vouch_topic) {
                (EventKind::Vouch, p.vouch_tail)
            } else if topic0_matches(topic0, &p.revoke_topic) {
                (EventKind::Revoke, p.revoke_tail)
            } else if topic0_matches(topic0, &p.reaffirm_topic) {
                (EventKind::Reaffirm, p.reaffirm_tail)
            } else if topic0_matches(topic0, &p.report_topic) {
                (EventKind::Report, p.report_tail)
            } else if topic0_matches(topic0, &p.report_resolved_topic) {
                (EventKind::ReportResolved, p.report_resolved_tail)
            } else {
                continue; // not one of the configured trust-graph topics
            };

            // Bounds-check against the CONFIGURED indices, not a hardcoded `len() < 3`. A
            // deployment reading `scope` from topics[3] needs four topics; one that maps
            // from/to to topics[2]/topics[1] still needs three. Checking the actual indices
            // this deployment uses keeps a misconfigured params string from panicking the WASM
            // module on a real block.
            let max_topic = p.from_topic.max(p.to_topic).max(p.scope_topic.unwrap_or(0));
            if log.topics.len() <= max_topic {
                continue;
            }

            let from = addr_from_topic(&log.topics[p.from_topic]);
            let to = addr_from_topic(&log.topics[p.to_topic]);
            let scope = p
                .scope_topic
                .map(|i| hex0x(&log.topics[i]))
                .unwrap_or_default();
            let (issued_at, expires_at) = decode_timing(tail, &log.data, block_timestamp);

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
                scope,
            });
        }
    }

    Ok(TrustEvents { events })
}

// ─── store_edges ───────────────────────────────────────────────────────────

/// The edge identity under trust-graph v0.2.0: (protocol, network, scope, from, to).
///
/// `network` and `scope` are load-bearing parts of the identity, not decoration:
///   * **network** — the SAME protocol indexed on two chains (EAS on Base and EAS on Optimism)
///     shares `protocol=eas`, so without it an edge on one chain overwrites the
///     identically-addressed edge on the other. Addresses are not chain-scoped; the key has to be.
///   * **scope**   — one EAS attester routinely holds several live attestations about the same
///     recipient under different schemas. Without `scope`, revoking one collapses all of them
///     into a single revoked edge.
/// schema.sql's ORDER BY mirrors this tuple.
fn edge_key(protocol: &str, network: &str, scope: &str, from: &[u8], to: &[u8]) -> String {
    format!(
        "edge:{protocol}:{network}:{scope}:{}:{}",
        hex::encode(from),
        hex::encode(to)
    )
}

// KNOWN LIMITATION — read this before changing store_edges:
//
// `updatePolicy: set` stores in Substreams cannot read their own prior state
// from within their own handler. Under substreams 1.20.2, declaring
// `store_edges` as its own `mode: get` input (so a REAFFIRM or REVOKE event
// could recover the `weight_raw`/`issued_at` an earlier VOUCH wrote for the
// same key) is rejected by `substreams info` with `modules graph has a cycle`
// — a store module may not depend on itself. `StoreSetProto<T>` also has no
// `get_*` methods at all: a set-store's own write handle is write-only.
//
// So, within the single `store_edges` module docs/14-substreams.md §2 names,
// a REAFFIRM or REVOKE event can only write the fields IT carries; it cannot
// recover `weight_raw` / `issued_at` from an earlier VOUCH for the same key.
// On the live reference deployment this is a *latent* limitation, not an
// active bug: World Chain Sepolia has no Revoked/Reaffirmed events at all
// (see ../PROOF.md), so every Edge this store currently produces is a
// complete, correct VOUCH record.
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
        let key = edge_key(&ev.protocol, &ev.network, &ev.scope, &ev.from, &ev.to);
        let kind = EventKind::try_from(ev.kind).unwrap_or(EventKind::Vouch);

        let mut edge = Edge {
            protocol: ev.protocol.clone(),
            network: ev.network.clone(),
            from: ev.from.clone(),
            to: ev.to.clone(),
            // "0", not `String::new()`: schema.sql's `weight_raw` column is ClickHouse
            // `Decimal(38, 18)`, which rejects an empty string outright and fails the WHOLE flush
            // batch, not just this field. Reachable for a REAFFIRM- or REVOKE-first key, which has
            // no prior VOUCH to take a weight from under this single-store design (see the KNOWN
            // LIMITATION note above). "0" is still an honestly-incomplete placeholder, same as the
            // rest of this freshly-zeroed `edge` — it is just one the sink can actually store.
            weight_raw: "0".to_string(),
            issued_at: 0,
            expires_at: 0,
            revoked: false,
            renew_count: 0,
            kind: EventKind::Vouch as i32,
            tx_hash: vec![],
            block_num: 0,
            scope: ev.scope.clone(),
        };

        // Applies to every kind, not just VOUCH: `ev.issued_at` is always well-defined
        // (`decode_timing`'s doc comment) — the event's own decoded ABI word for VOUCH, or the
        // containing block's real timestamp for every kind whose shape carries no issuance word
        // of its own. It has to be carried into the `Edge` here rather than inside the `Vouch`
        // arm below, or a REAFFIRM- or REVOKE-first key (no prior VOUCH under this single-store
        // design) keeps the freshly-zeroed initializer's `issued_at: 0` in the row sent to the
        // sink.
        edge.issued_at = ev.issued_at;

        match kind {
            EventKind::Vouch => {
                edge.weight_raw = ev.weight_raw.clone();
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

/// Clamp a decoded `uint64` timing field into ClickHouse `DateTime`'s valid range
/// (`[0, 4294967295]` — 1970-01-01 through 2106-02-07, since the column is 32-bit).
///
/// Why this exists: a contract with two indexed addresses does not necessarily carry timing data
/// in its non-indexed tail (docs/14 §2's `issued_at`/`expires_at`). VouchMeRegistry and Circles v2's
/// `Trust.expiryTime` do; EAS's `Attested(address indexed,address indexed,bytes32,bytes32 indexed)`
/// on Base structurally matches but its one non-indexed word is a content-addressed `uid` hash.
/// `tail=none` is the declared way to say so, but a misconfigured profile can still read a hash
/// through `word_u64`, producing an arbitrary, often huge or (interpreted as `i64`) negative
/// number. ClickHouse's `DateTime` column rejects that outright and the whole flush batch fails,
/// not just that row. One shape-mismatched event able to wedge the entire sink is worse than
/// storing a clamped, honestly-wrong sentinel for a field that pairing was never going to
/// populate meaningfully.
fn clamp_unix_timestamp(value: u64) -> i64 {
    const CLICKHOUSE_DATETIME_MAX: u64 = 4_294_967_295;
    value.min(CLICKHOUSE_DATETIME_MAX) as i64
}

#[substreams::handlers::map]
fn map_edge_deltas(deltas: Deltas<DeltaProto<Edge>>) -> Result<DatabaseChanges, Error> {
    let mut tables = Tables::new();

    for delta in deltas.deltas {
        let edge = &delta.new_value;
        let kind = EventKind::try_from(edge.kind).unwrap_or(EventKind::Vouch);
        // MUST match schema.sql's `ORDER BY (protocol, network, scope, to_addr, from_addr)`
        // column-for-column: that ORDER BY is the ReplacingMergeTree dedupe key, so any column
        // in it that is NOT in this CDC key would let two genuinely different edges collapse
        // into one on merge (or, worse, dedupe non-deterministically).
        let key = [
            ("protocol", edge.protocol.as_str()),
            ("network", edge.network.as_str()),
            ("scope", edge.scope.as_str()),
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
                    // `network` and `scope` are supplied by `key` above — setting them again
                    // here would send the same column twice in one INSERT.
                    .set("kind", kind.as_str_name())
                    .set("weight_raw", edge.weight_raw.as_str())
                    .set("issued_at", clamp_unix_timestamp(edge.issued_at))
                    .set("expires_at", clamp_unix_timestamp(edge.expires_at))
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
    use prost_types::Timestamp;
    use substreams_ethereum::pb::eth::v2::{
        Block, BlockHeader, Call, Log, TransactionReceipt, TransactionTrace,
    };

    // Real params for the live deployment, deployments/worldchain-sepolia.json.
    const REAL_PARAMS: &str = "contract=0x1d9955cb9f2a531fa6d4f43e712c9b1fa9a44514&vouch_topic=0x1023f6bd7654e275f0ff5868480691e3f5feb9960e997af34f0cf9e4b33e22b9&revoke_topic=0xb1c57350b08a198ff1a7862eeb3246e35fa3fc8e954bc691997ce37da018cbc7&reaffirm_topic=0x9089bae040c16337c6e96ac1661dba8c85c8b076f44d68407b4fa00243c05db7&report_topic=&report_resolved_topic=&model=WEIGHTED&protocol=vouchme&network=worldchain-sepolia";

    fn hex_bytes(s: &str) -> Vec<u8> {
        hex::decode(s.strip_prefix("0x").unwrap_or(s)).unwrap()
    }

    /// Builds a `Block` carrying exactly one real log, captured live from
    /// World Chain Sepolia via `eth_getLogs` against the deployed
    /// VouchMeRegistry (0x1d9955...4514) — see ../PROOF.md for the raw RPC
    /// response and how it was captured. This is the same shape
    /// `substreams-testing`'s "Constructing Ethereum blocks" pattern uses.
    fn block_with_real_log(
        block_number: u64,
        block_timestamp_secs: u64,
        tx_hash_hex: &str,
        log_address_hex: &str,
        topics_hex: &[&str],
        data_hex: &str,
    ) -> Block {
        Block {
            number: block_number,
            header: Some(BlockHeader {
                timestamp: Some(Timestamp { seconds: block_timestamp_secs as i64, nanos: 0 }),
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
                // — silently, no panic — so every fixture must populate `calls` too.
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
            1_784_980_220, // real block timestamp — equals this Vouched's decoded issuedAt below
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
        assert_eq!(ev.protocol, "vouchme");
        assert_eq!(ev.network, "worldchain-sepolia");
        assert_eq!(hex::encode(&ev.from), "defbe7d71f0eae651399c0fb97cf93fa09ee0780");
        assert_eq!(hex::encode(&ev.to), "ee0f520a7cd3f6998dee6463dfe3fc49e040520b");
        assert_eq!(ev.issued_at, 1784980220);
        assert_eq!(ev.expires_at, 1792756220);
        assert_eq!(ev.expires_at - ev.issued_at, 90 * 86400, "VouchMe vouches expire after 90 days");
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
            1_784_980_222,
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
            1_784_980_226,
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

    /// A `Trust`/`Attested`-shaped event whose non-indexed word is a content hash rather than a
    /// timestamp (EAS's `uid` on Base — see PROOF.md) decodes to a `u64` so large that `as i64`
    /// wraps negative, and ClickHouse `DateTime` parsing then fails the whole flush batch, not
    /// just the one row. Clamping must land safely in `DateTime`'s 32-bit range regardless of how
    /// large the u64 input is, with no cast-related sign flip.
    #[test]
    fn clamp_unix_timestamp_never_goes_negative_or_out_of_range() {
        assert_eq!(clamp_unix_timestamp(0), 0);
        assert_eq!(clamp_unix_timestamp(1_784_980_220), 1_784_980_220); // a real Vouched issuedAt
        assert_eq!(clamp_unix_timestamp(4_294_967_295), 4_294_967_295); // exactly the DateTime max
        assert_eq!(clamp_unix_timestamp(4_294_967_296), 4_294_967_295); // one past max: clamps
        // A real EAS `uid` on Base read through word_u64 (see PROOF.md) — u64::from_be_bytes on a
        // hash's low 8 bytes, which is > i64::MAX and would flip negative under a bare `as i64`
        // cast.
        let real_garbage_uid_low_bytes: u64 = 17_970_774_945_481_514_775;
        assert!(real_garbage_uid_low_bytes > i64::MAX as u64);
        let clamped = clamp_unix_timestamp(real_garbage_uid_low_bytes);
        assert!(clamped >= 0, "must never be negative");
        assert_eq!(clamped, 4_294_967_295);
    }

    /// REAFFIRM's ABI shape (one word, `expiresAt` only) carries no `issuedAt`, so the raw event's
    /// `issued_at` must fall back to the block clock and never to `0`. `0` is not a neutral
    /// "unknown" but literal 1970-01-01, i.e. wrong in the single most damaging direction for a
    /// tenure input: such an edge reads as maximally old to any freshness computation.
    /// `block_timestamp` is the actual time this REAFFIRM happened on chain — always true of it,
    /// even though it is not the same fact as "when was this edge's original VOUCH" (that gap is
    /// the separate `store_edges` KNOWN LIMITATION documented above `store_edges`).
    #[test]
    fn reaffirm_issued_at_falls_back_to_block_timestamp_not_zero() {
        // Synthetic (not a captured real log) — REAFFIRM has no occurrences on the live VouchMe
        // deployment to capture from (PROOF.md) — but the topic0, address shape, and single-word
        // `expiresAt` payload are the real, verified `Reaffirmed(address,address,uint64)` layout.
        let block = block_with_real_log(
            32216500,
            1_784_990_000, // an arbitrary but real-shaped block timestamp
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "0x1d9955cb9f2a531fa6d4f43e712c9b1fa9a44514",
            &[
                "0x9089bae040c16337c6e96ac1661dba8c85c8b076f44d68407b4fa00243c05db7", // reaffirm_topic
                "0x000000000000000000000000defbe7d71f0eae651399c0fb97cf93fa09ee0780",
                "0x000000000000000000000000ee0f520a7cd3f6998dee6463dfe3fc49e040520b",
            ],
            // one word: new expiresAt = 1_792_756_220 (0x6adb49fc)
            "0x000000000000000000000000000000000000000000000000000000006adb49fc",
        );

        let out = testing::map!(map_trust_events(REAL_PARAMS.to_string(), block)).unwrap();
        assert_eq!(out.events.len(), 1);
        let ev = &out.events[0];
        assert_eq!(ev.kind, EventKind::Reaffirm as i32);
        assert_ne!(ev.issued_at, 0, "must never silently default to Unix epoch / 1970-01-01");
        assert_eq!(ev.issued_at, 1_784_990_000, "must equal the containing block's real timestamp");
        assert_eq!(ev.expires_at, 1_792_756_220, "expiresAt is still decoded from the event's own word");
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
            1_784_980_220,
            "0x4e3f68550eb01521d73ab56ac5663d12f7f43a7eb26e990ccc329e4127c6465b",
            "0x0000000000000000000000000000000000dead", // not VouchMeRegistry
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
    /// and here, the dynamic `string` tail) work correctly. See ../PROOF.md
    /// for the full worked decode and the raw log.
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
        // Pre-rename on-chain bytes: this log was emitted while the protocol was still called
        // Aval, so the handle it carries really is `anchor1.aval.eth`. The expectation tracks
        // what the chain says, not what the product is called today.
        assert_eq!(handle, "anchor1.aval.eth");
    }

    // ─── World Chain MAINNET (chainId 480) — the currently shipped target ──────
    //
    // Everything above this line decodes real logs from the *Sepolia* (4801)
    // reference deployment. They are kept because they are real bytes and they
    // still exercise every decode branch — but they do not describe the contract
    // this package ships pointed at. The tests below cover that against the live
    // mainnet deployment.

    /// The params string the shipped manifest actually deploys with, read out of
    /// `substreams.yaml` itself at compile time. This is deliberately NOT a copy:
    /// if someone edits the manifest's contract address or a topic0 and forgets the
    /// tests, the assertions below fail rather than silently keep proving a decode
    /// against a contract nobody indexes any more.
    fn shipped_params() -> String {
        const MANIFEST: &str = include_str!("../substreams.yaml");
        let line = MANIFEST
            .lines()
            .find(|l| l.trim_start().starts_with("map_trust_events:"))
            .expect("substreams.yaml must define params.map_trust_events");
        let start = line.find('"').expect("params value must be quoted");
        let end = line.rfind('"').expect("params value must be quoted");
        line[start + 1..end].to_string()
    }

    #[test]
    fn shipped_params_target_the_live_mainnet_registry() {
        let p = parse_params(&shipped_params()).unwrap();
        assert_eq!(
            hex::encode(p.contract),
            "6fefef2d44203300a6a33d631840c972181b8722",
            "shipped manifest must point at VouchMeRegistry on World Chain mainnet"
        );
        assert_eq!(p.network, "worldchain");
        assert_eq!(p.protocol, "vouchme");
        assert_eq!(p.model, "WEIGHTED");
        assert!(p.vouch_topic.is_some() && p.revoke_topic.is_some() && p.reaffirm_topic.is_some());
    }

    /// The FIRST real `Vouched` event on World Chain mainnet, decoded with the
    /// shipped params — block 32835377, tx
    /// 0x563172cb968bb63b2ba362fa95d6ff257bf94554076ebbbb39e3969cab3d5c45, logIndex 42.
    ///
    /// Bytes below are verbatim from `cast logs --address
    /// 0x6fEfEf2d44203300a6a33d631840C972181b8722 <vouch topic0> --rpc-url
    /// https://worldchain-mainnet.g.alchemy.com/public` at block 32835377; the same
    /// values come back from a live `substreams run ... -e worldchain` of this very
    /// module (../PROOF.md §9). Two independent sources, identical bytes.
    #[test]
    fn decodes_the_real_mainnet_vouched_event() {
        let block = block_with_real_log(
            32835377,
            1_785_006_393, // real block timestamp; equals this Vouched's own decoded issuedAt
            "0x563172cb968bb63b2ba362fa95d6ff257bf94554076ebbbb39e3969cab3d5c45",
            "0x6fefef2d44203300a6a33d631840c972181b8722",
            &[
                "0x1023f6bd7654e275f0ff5868480691e3f5feb9960e997af34f0cf9e4b33e22b9",
                "0x000000000000000000000000b23a3b2384d721d7c487a3acc6405a1d36672b47",
                "0x0000000000000000000000004774b9621102eac2254365f9311c4e7700d9e7de",
            ],
            "0x000000000000000000000000000000000000000000000000000000006a650939000000000000000000000000000000000000000000000000000000006adbb039",
        );

        let out = testing::map!(map_trust_events(shipped_params(), block)).unwrap();

        assert_eq!(out.events.len(), 1, "expected exactly one decoded TrustEvent");
        let ev = &out.events[0];
        assert_eq!(ev.kind, EventKind::Vouch as i32);
        assert_eq!(ev.protocol, "vouchme");
        assert_eq!(ev.network, "worldchain");
        assert_eq!(hex::encode(&ev.from), "b23a3b2384d721d7c487a3acc6405a1d36672b47");
        assert_eq!(hex::encode(&ev.to), "4774b9621102eac2254365f9311c4e7700d9e7de");
        assert_eq!(ev.issued_at, 1_785_006_393);
        assert_eq!(ev.expires_at, 1_792_782_393);
        assert_eq!(ev.expires_at - ev.issued_at, 90 * 86400, "VouchMe vouches expire after 90 days");
        assert_eq!(ev.block_num, 32835377);
        assert_eq!(
            hex::encode(&ev.tx_hash),
            "563172cb968bb63b2ba362fa95d6ff257bf94554076ebbbb39e3969cab3d5c45"
        );
    }

    /// The mainnet `Enrolled` logs are NOT trust edges and must not become them.
    /// `Enrolled(address indexed account, uint256 indexed nullifierHash, ...)`'s
    /// topics[2] is a nullifier hash, not an address — if the module ever matched it,
    /// `to` would silently become 20 bytes sliced out of a hash. Real bytes from
    /// block 32833881, tx 0xcbafd84a98bc5e8f2eb7e5a660cfaf57220a344fb5fdc8164a289bed239869f4
    /// (`romariokavin.aval.eth` — pre-rename bytes, see the assertion at the end).
    #[test]
    fn real_mainnet_enrolled_log_is_not_decoded_as_an_edge() {
        let block = block_with_real_log(
            32833881,
            1_785_005_193,
            "0xcbafd84a98bc5e8f2eb7e5a660cfaf57220a344fb5fdc8164a289bed239869f4",
            "0x6fefef2d44203300a6a33d631840c972181b8722",
            &[
                "0x21f09afe14df68eeb2c0fd22ba443b93b0e63d090521d32444903f1d1277793f",
                "0x0000000000000000000000004774b9621102eac2254365f9311c4e7700d9e7de",
                "0x083e09bff054d1b2ec02f48990da0347a522ae3ca412f6ef734ef2609e6f535d",
            ],
            "0x429ce4cb526a44a771b6ab14f907675b23c55c05b7127bcfecf925e2131c4e06\
              000000000000000000000000000000000000000000000000000000006adba489\
              0000000000000000000000000000000000000000000000000000000000000060\
              0000000000000000000000000000000000000000000000000000000000000015\
              726f6d6172696f6b6176696e2e6176616c2e6574680000000000000000000000",
        );

        let out = testing::map!(map_trust_events(shipped_params(), block)).unwrap();
        assert!(
            out.events.is_empty(),
            "Enrolled is account context, not a trust edge — it has no topic0 in the shipped params"
        );

        // …but the handle in it is still real, and still decodes, exactly as the
        // Sepolia-era test above proves for a different account.
        let data = hex_bytes(
            "0x429ce4cb526a44a771b6ab14f907675b23c55c05b7127bcfecf925e2131c4e06\
              000000000000000000000000000000000000000000000000000000006adba489\
              0000000000000000000000000000000000000000000000000000000000000060\
              0000000000000000000000000000000000000000000000000000000000000015\
              726f6d6172696f6b6176696e2e6176616c2e6574680000000000000000000000",
        );
        let str_offset = word_u64(&data[64..96]) as usize;
        let str_len = word_u64(&data[str_offset..str_offset + 32]) as usize;
        let handle = std::str::from_utf8(&data[str_offset + 32..str_offset + 32 + str_len]).unwrap();
        // Pre-rename on-chain bytes, as above: the enrolled handle really is `…aval.eth`.
        assert_eq!(handle, "romariokavin.aval.eth");
    }

    // ── trust-graph v0.2.0: the EAS adapter profile ────────────────────────
    //
    // Every log below is REAL, captured from EAS on Base
    // (0x4200000000000000000000000000000000000021) via base.blockscout.com's log API —
    // addresses, topics, data, tx hashes and block numbers verbatim, nothing edited. See
    // ../PROOF.md §9.3 for the capture and the independent cross-check.

    /// The EAS adapter profile, exactly as docs/17-trust-graph-standard.md §6.2 registers it and
    /// as substreams.yaml's `networks:` block ships it. Read `from_topic=2&to_topic=1` carefully:
    /// that is the whole point — EAS declares the SUBJECT first.
    const EAS_BASE_PARAMS: &str = "contract=0x4200000000000000000000000000000000000021\
        &vouch_topic=0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35\
        &revoke_topic=0xf930a6e2523c9cc298691873087a740550b8fc85a0680830414c148ed927f615\
        &reaffirm_topic=&report_topic=&report_resolved_topic=\
        &from_topic=2&to_topic=1&scope_topic=3\
        &vouch_tail=none&revoke_tail=none\
        &model=ISSUANCE&protocol=eas&network=base";

    /// A real `Attested` log, block 49109539, tx 0x174b15fa…745f.
    ///
    /// EAS's declaration is
    /// `Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schemaUID)`
    /// — SUBJECT first, asserter second. The two assertions that matter here are the `from`/`to`
    /// pair: `from` must be the ATTESTER (0x357458…d7ee, topics[2]) and `to` the RECIPIENT
    /// (0xf46f5d…5e50, topics[1]). The default topic order would give the opposite — see
    /// `v0_1_0_topic_order_would_reverse_this_eas_edge` below.
    #[test]
    fn decodes_a_real_eas_attested_log_with_the_attester_as_from() {
        let block = block_with_real_log(
            49109539,
            1_785_003_000, // real Base block clock; EAS's log carries no timing word of its own
            "0x174b15fa836b87a91fa0d0e626b7056e92a355a660c4c7cbf43fae763593745f",
            "0x4200000000000000000000000000000000000021",
            &[
                "0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35",
                "0x000000000000000000000000f46f5d2eeb4d9085d6bd67c38a5b622f7e8e5e50", // recipient
                "0x000000000000000000000000357458739f90461b99789350868cd7cf330dd7ee", // attester
                "0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4", // schemaUID
            ],
            // the whole non-indexed tail: the attestation `uid`. A content hash, not a clock.
            "0x67ac403444d485a7f0a851acbde2dae1dc3b8b8acb0c2b904b58609ff5c659b3",
        );

        let out = testing::map!(map_trust_events(EAS_BASE_PARAMS.to_string(), block)).unwrap();
        assert_eq!(out.events.len(), 1);
        let ev = &out.events[0];

        assert_eq!(ev.protocol, "eas");
        assert_eq!(ev.network, "base");
        // An attestation being issued IS a trust assertion — VOUCH, not REAFFIRM.
        assert_eq!(ev.kind, EventKind::Vouch as i32);
        assert_eq!(
            hex::encode(&ev.from),
            "357458739f90461b99789350868cd7cf330dd7ee",
            "`from` must be the ATTESTER (topics[2]) — the party making the assertion"
        );
        assert_eq!(
            hex::encode(&ev.to),
            "f46f5d2eeb4d9085d6bd67c38a5b622f7e8e5e50",
            "`to` must be the RECIPIENT (topics[1]) — the party being asserted about"
        );
        assert_eq!(
            ev.scope, "0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4",
            "scope carries EAS's schemaUID so parallel same-pair attestations stay distinct"
        );
        // `vouch_tail=none`: no timing in the log, so issuance is the block's own clock and
        // expiry is the standard's perpetual sentinel 0 — NOT a `uid` misread as a year-2106
        // timestamp.
        assert_eq!(ev.issued_at, 1_785_003_000);
        assert_eq!(ev.expires_at, 0);
        assert_eq!(ev.block_num, 49109539);
    }

    /// Pins what the DEFAULT topic order means for an EAS log. Same real log, same everything,
    /// except the params omit the explicit roles and fall back to `from_topic=1&to_topic=2`. The
    /// decode still "succeeds" and still produces two real, plausible-looking addresses — it just
    /// names the wrong one as the asserter. That is why the roles are declared rather than
    /// inferred: no ABI-level signal distinguishes the two orderings, and the wrong answer is
    /// indistinguishable from the right one by inspection of the output alone.
    #[test]
    fn v0_1_0_topic_order_would_reverse_this_eas_edge() {
        let block = block_with_real_log(
            49109539,
            1_785_003_000,
            "0x174b15fa836b87a91fa0d0e626b7056e92a355a660c4c7cbf43fae763593745f",
            "0x4200000000000000000000000000000000000021",
            &[
                "0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35",
                "0x000000000000000000000000f46f5d2eeb4d9085d6bd67c38a5b622f7e8e5e50",
                "0x000000000000000000000000357458739f90461b99789350868cd7cf330dd7ee",
                "0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4",
            ],
            "0x67ac403444d485a7f0a851acbde2dae1dc3b8b8acb0c2b904b58609ff5c659b3",
        );
        let v0_1_0_style = EAS_BASE_PARAMS.replace("&from_topic=2&to_topic=1", "");

        let out = testing::map!(map_trust_events(v0_1_0_style, block)).unwrap();
        let ev = &out.events[0];

        // The recipient ends up in `from` — the edge points backwards.
        assert_eq!(hex::encode(&ev.from), "f46f5d2eeb4d9085d6bd67c38a5b622f7e8e5e50");
        assert_eq!(hex::encode(&ev.to), "357458739f90461b99789350868cd7cf330dd7ee");
    }

    /// A real `Revoked` log, block 49109984, tx 0xc91462bc…fa18 — same schema
    /// (0x254bd1…f9f4) and same attester as the `Attested` above, so it exercises the kind
    /// dispatch and the role mapping together.
    #[test]
    fn decodes_a_real_eas_revoked_log_as_revoke() {
        let block = block_with_real_log(
            49109984,
            1_785_003_890,
            "0xc91462bcdcd454238b631172216747e91bbef3490da81ffa2723ce1e9d7bfa18",
            "0x4200000000000000000000000000000000000021",
            &[
                "0xf930a6e2523c9cc298691873087a740550b8fc85a0680830414c148ed927f615",
                "0x000000000000000000000000fde64995acd78435c63505a066273abdd979386c", // recipient
                "0x000000000000000000000000357458739f90461b99789350868cd7cf330dd7ee", // attester
                "0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4",
            ],
            "0xa07e8d5110c0cac807ee07d263d22747a0d6a8b68759e34ec34f3d01f6a67fa9",
        );

        let out = testing::map!(map_trust_events(EAS_BASE_PARAMS.to_string(), block)).unwrap();
        assert_eq!(out.events.len(), 1);
        let ev = &out.events[0];
        assert_eq!(ev.kind, EventKind::Revoke as i32);
        assert_eq!(hex::encode(&ev.from), "357458739f90461b99789350868cd7cf330dd7ee");
        assert_eq!(hex::encode(&ev.to), "fde64995acd78435c63505a066273abdd979386c");
        // `revoke_tail=none`: the log's only non-indexed word is a `uid`, so reading it as this
        // revocation's `at` would give an absurd `issued_at`. The block clock is the real,
        // checkable answer.
        assert_eq!(ev.issued_at, 1_785_003_890);
        assert_eq!(ev.expires_at, 0);
    }

    /// `scope` is part of the edge IDENTITY, not decoration. Two attestations from the same
    /// attester about the same recipient under DIFFERENT schemas must be two edges — otherwise
    /// revoking one silently revokes the other. Both schema UIDs below are real ones seen on
    /// Base in the captured window.
    #[test]
    fn scope_keeps_same_pair_different_schema_edges_distinct() {
        let attester = hex_bytes("0x357458739f90461b99789350868cd7cf330dd7ee");
        let recipient = hex_bytes("0xfde64995acd78435c63505a066273abdd979386c");
        let schema_a = "0x254bd1b63e0591fefa66818ca054c78627306f253f86be6023725a67ee6bf9f4";
        let schema_b = "0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9";

        let key_a = edge_key("eas", "base", schema_a, &attester, &recipient);
        let key_b = edge_key("eas", "base", schema_b, &attester, &recipient);
        assert_ne!(key_a, key_b, "different schemaUID must mean a different edge");

        // …and the SAME edge on a different chain is also a different edge. Addresses are not
        // chain-scoped, so without `network` in the key EAS-on-Base would overwrite
        // EAS-on-Optimism.
        let key_op = edge_key("eas", "optimism", schema_a, &attester, &recipient);
        assert_ne!(key_a, key_op, "same protocol on another chain must be a different edge");

        // VouchMe's empty scope is still a well-formed, distinct key — not a degenerate case.
        let vouchme = edge_key("vouchme", "worldchain", "", &attester, &recipient);
        assert!(vouchme.starts_with("edge:vouchme:worldchain::"));
    }

    /// A params typo must fail loudly. `vouch_tail=nil` is not a layout; accepting it and
    /// falling back to "guess from the kind" is how a `uid` becomes a year-2106 expiry.
    #[test]
    fn parse_params_rejects_an_unknown_tail_layout() {
        let bad = EAS_BASE_PARAMS.replace("vouch_tail=none", "vouch_tail=nil");
        let err = parse_params(&bad).unwrap_err().to_string();
        assert!(err.contains("unknown vouch_tail"), "unexpected error: {err}");
    }

    /// Role indices must be sane. Both of these are silent-corruption vectors if allowed:
    /// index 0 is topic0 (the event signature, not an address), and identical indices would
    /// make every edge a self-loop.
    #[test]
    fn parse_params_rejects_degenerate_role_indices() {
        let zero = EAS_BASE_PARAMS.replace("from_topic=2", "from_topic=0");
        assert!(parse_params(&zero).unwrap_err().to_string().contains("1-based"));

        let same = EAS_BASE_PARAMS.replace("from_topic=2", "from_topic=1");
        assert!(parse_params(&same).unwrap_err().to_string().contains("must differ"));
    }

    /// Every `map_trust_events: "..."` params value declared in a manifest, in file order.
    /// Works for both manifests: `substreams.yaml` names the module `map_trust_events`,
    /// `substreams.sink.yaml` names it `main:map_trust_events` after the import.
    fn manifest_param_values(manifest: &str) -> Vec<String> {
        manifest
            .lines()
            .map(str::trim_start)
            .filter(|l| l.starts_with("map_trust_events:") || l.starts_with("main:map_trust_events:"))
            .filter_map(|l| {
                let start = l.find('"')?;
                let end = l.rfind('"')?;
                (end > start).then(|| l[start + 1..end].to_string())
            })
            .collect()
    }

    /// The two manifests must declare the SAME five adapter profiles.
    ///
    /// `substreams.sink.yaml` cannot inherit `networks:` from the package it imports — importing
    /// namespaces every module name — so the profiles are physically duplicated. Duplication that
    /// nothing checks is duplication that drifts, and a drifted sink profile is the worst kind of
    /// bug here: it would write real, plausible rows decoded under the WRONG protocol's rules.
    /// This test is the check.
    #[test]
    fn sink_profiles_match_the_streaming_manifest() {
        let stream = manifest_param_values(include_str!("../substreams.yaml"));
        let sink = manifest_param_values(include_str!("../substreams.sink.yaml"));

        assert_eq!(stream.len(), 6, "1 default + 5 network profiles in substreams.yaml");
        assert_eq!(sink.len(), 6, "1 default + 5 network profiles in substreams.sink.yaml");
        assert_eq!(stream, sink, "sink manifest profiles have drifted from the streaming manifest");

        // …and every one of them must actually parse, with the protocol/network pair it claims.
        let seen: Vec<(String, String)> = stream
            .iter()
            .map(|raw| {
                let p = parse_params(raw).expect("every shipped profile must parse");
                (p.protocol, p.network)
            })
            .collect();
        for expected in [
            ("vouchme", "worldchain"),
            ("eas", "base"),
            ("eas", "optimism"),
            ("eas", "arbitrum"),
            ("eas", "mainnet"),
        ] {
            assert!(
                seen.iter().any(|(pr, nw)| pr == expected.0 && nw == expected.1),
                "missing registered adapter profile {expected:?}; found {seen:?}"
            );
        }
    }

    /// Every EAS profile must carry the three corrections that make EAS edges mean the right
    /// thing. Pinned as a test because getting any one of them wrong produces output that still
    /// looks entirely plausible (real addresses, real hashes) while being wrong.
    #[test]
    fn every_eas_profile_declares_the_corrected_role_scope_and_tail_mapping() {
        let profiles: Vec<Params> = manifest_param_values(include_str!("../substreams.yaml"))
            .iter()
            .map(|raw| parse_params(raw).unwrap())
            .filter(|p| p.protocol == "eas")
            .collect();
        assert_eq!(profiles.len(), 4, "EAS is registered on four chains");

        for p in &profiles {
            assert_eq!(p.from_topic, 2, "{}: `from` must be the attester", p.network);
            assert_eq!(p.to_topic, 1, "{}: `to` must be the recipient", p.network);
            assert_eq!(p.scope_topic, Some(3), "{}: scope must be schemaUID", p.network);
            assert_eq!(p.vouch_tail, TailLayout::None, "{}: Attested has no timing word", p.network);
            assert_eq!(p.revoke_tail, TailLayout::None, "{}: Revoked has no timing word", p.network);
            assert!(p.vouch_topic.is_some() && p.revoke_topic.is_some());
        }
    }

    /// A log with too few topics for the CONFIGURED indices is skipped, not panicked on.
    /// `scope_topic=3` needs four topics; an `Attested`-shaped log with only three would have
    /// indexed out of bounds inside the WASM module on a real block.
    #[test]
    fn skips_logs_with_too_few_topics_for_the_configured_indices() {
        let block = block_with_real_log(
            49109539,
            1_785_003_000,
            "0x174b15fa836b87a91fa0d0e626b7056e92a355a660c4c7cbf43fae763593745f",
            "0x4200000000000000000000000000000000000021",
            &[
                "0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35",
                "0x000000000000000000000000f46f5d2eeb4d9085d6bd67c38a5b622f7e8e5e50",
                "0x000000000000000000000000357458739f90461b99789350868cd7cf330dd7ee",
                // no topics[3] — scope_topic=3 cannot be satisfied
            ],
            "0x67ac403444d485a7f0a851acbde2dae1dc3b8b8acb0c2b904b58609ff5c659b3",
        );
        let out = testing::map!(map_trust_events(EAS_BASE_PARAMS.to_string(), block)).unwrap();
        assert_eq!(out.events.len(), 0);
    }
}
