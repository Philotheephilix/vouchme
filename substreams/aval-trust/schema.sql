-- trust_edges — docs/14-substreams.md §4, verbatim.
--
-- ORDER BY (protocol, network, scope, to_addr, from_addr) because the engine's hot query is
-- "all inbound edges for every account" — the BFS inner loop
-- (docs/05-graph-data-layer.md §2.2 / §3.2) — and because that tuple is the trust-graph v0.2.0
-- EDGE IDENTITY (docs/17-trust-graph-standard.md §4.3). It must stay identical to `edge_key()`
-- in src/lib.rs and to the CDC key in `map_edge_deltas`. The v0.1.0 key
-- (protocol, to_addr, from_addr) silently merged EAS-on-Base with EAS-on-Optimism, and merged
-- an attester's several different-schema attestations about one recipient into a single edge.
--
-- ReplacingMergeTree(block_num) plus `FINAL` at query time is the standard ClickHouse idiom for
-- a table fed by insert-only Database Changes CDC (substreams-sink-sql on ClickHouse is
-- insert-only — see substreams-sql skill, "Capability matrix"): every state
-- change (VOUCH / REAFFIRM / REVOKE) is inserted as a new row for the same
-- (protocol, network, scope, to_addr, from_addr) key with a higher block_num, and a merge (or
-- `FINAL`) keeps only the highest block_num per key.
--
-- The standard's LIVENESS PREDICATE, which every consumer should use verbatim
-- (docs/17-trust-graph-standard.md §5.2) — note the perpetual-sentinel arm, without which every
-- EAS edge looks expired:
--     revoked = 0 AND (expires_at = toDateTime(0) OR expires_at > now())
--
-- IMPORTANT for anyone editing this file: substreams-sink-sql's statement splitter is NOT
-- comment-aware — it splits on every literal semicolon in the raw text, including ones inside
-- `--` comments, and executes every resulting chunk (even a comment-only, effectively-empty one)
-- as its own statement, which ClickHouse rejects with `code: 62, Empty query`. Found by actually
-- running `setup`, three times, before landing on "no semicolon anywhere except the one real
-- statement terminator below" as the only reliable fix. This file must contain exactly one.
CREATE TABLE trust_edges (
    protocol     LowCardinality(String),
    network      LowCardinality(String),
    -- `scope` — trust-graph v0.2.0's protocol-native edge discriminator (trust_graph.proto's
    -- `scope` field). EAS puts its `schemaUID` here, so one attester holding several live
    -- attestations about the same recipient under different schemas is several rows, and
    -- revoking one does not mark the others revoked. Aval writes the empty string: AvalRegistry
    -- permits exactly one live vouch per (voucher, vouchee) pair, so the pair is already unique
    -- and '' is the correct lossless value, not a placeholder. Part of the ORDER BY key below.
    scope        String,
    -- docs/14-substreams.md §4 specifies `FixedString(20)` for the two address columns and
    -- `FixedString(32)` for tx_hash (below) — a compact 20/32 RAW BYTES encoding. Deviated to
    -- `String`: `map_edge_deltas` (src/lib.rs) sends addresses and hashes through this table as
    -- `0x`-prefixed lowercase hex strings (`hex0x()` — 42 and 66 ASCII characters), matching the
    -- rest of the module's convention and every emitted log/test assertion. Against a
    -- `FixedString(N)` column that produced `from_addr input value with length 42 exceeds
    -- FixedString(20) capacity` on every real row (found by actually running the sink against
    -- live Base data, not by inspection) — `AppendRow` wants exactly N raw bytes, not a hex
    -- string of that length. Sending raw bytes instead would satisfy `FixedString` but breaks the
    -- hex0x convention used everywhere else, including the `/edges` HTTP endpoint's response
    -- shape (see ../README.md) — `String` keeps one consistent address encoding end to end.
    from_addr    String,
    to_addr      String,
    kind         Enum8('VOUCH'=0,'REVOKE'=1,'REAFFIRM'=2,'REPORT'=3,'REPORT_RESOLVED'=4),
    -- docs/14-substreams.md §4 specifies `Decimal(38, 18)` here. Deviated to `String`: the
    -- ClickHouse Database Changes driver in substreams-sink-sql v4.13.1 fails EVERY value through
    -- this path with `converting value "..." to type "decimal.Decimal": unsupported struct type
    -- decimal.Decimal` — reproduced with both "0" and "" (found by actually running the sink, not
    -- by inspection). The Postgres Database Changes path, which trust_edges does not use here,
    -- may not have this issue. `weight_raw` is documented as "protocol-native, unnormalized" in
    -- trust_graph.proto, an opaque string as far as this table is concerned. Normalization into
    -- a comparable number happens at the standardized-schema adapter layer instead
    -- (docs/05-graph-data-layer.md §3.3), not in this column. `String` loses no information the
    -- `Decimal` column was actually using and unblocks real inserts.
    weight_raw   String,
    -- `issued_at`: always the real time this specific event happened — the event's own decoded
    -- ABI word when its shape carries one (VOUCH, REVOKE/REPORT/REPORT_RESOLVED's `at`), the
    -- containing block's own timestamp otherwise (REAFFIRM, whose ABI shape carries only
    -- `expiresAt`). Never `0` (1970-01-01) — that was a real defect (a second reviewer caught it
    -- by querying this exact table directly), fixed in `src/lib.rs`'s `decode_timing` and
    -- `store_edges` (see PROOF.md for the before/after `SELECT`). It is still NOT necessarily the
    -- same moment as an edge's *original* VOUCH once a REAFFIRM has touched it — see the
    -- `store_edges` KNOWN LIMITATION doc comment in `src/lib.rs`.
    issued_at    DateTime,
    -- `expires_at`: `1970-01-01 00:00:00` (unix 0) is trust-graph v0.2.0's PERPETUAL sentinel —
    -- "this log proves no expiry" — NOT "expired long ago". Read it with the standard's
    -- liveness predicate, never with a bare `expires_at > now()`:
    --     revoked = 0 AND (expires_at = toDateTime(0) OR expires_at > now())
    -- Which deployments produce it, and why:
    --   * EAS (`Attested` / `Revoked`) — the log's only non-indexed word is the attestation
    --     `uid`, a content hash. There is no timing data in the event at all, so the adapter
    --     declares `vouch_tail=none` / `revoke_tail=none` and this column is honestly 0. EAS's
    --     real `expirationTime` lives in contract storage, reachable only via
    --     `getAttestation(uid)`, which this event-log-only extractor does not call.
    --   * Aval (`Vouched`) — carries two genuine `uint64` words, so this column holds a real
    --     decoded expiry (90 days after issuance) and is never 0.
    -- HISTORY, because the old rows were wrong in a way worth naming: under v0.1.0 the EAS
    -- mapping had no way to say "no timing here", so the `uid` hash was decoded as a timestamp
    -- and clamped to `4294967295` (2106-02-07 06:28:15) purely to stop it wedging this column.
    -- Those rows read as "never expires" and were fabricated by the decoder. v0.2.0's
    -- `TailLayout::None` removes the guess. `clamp_unix_timestamp` in src/lib.rs remains only as
    -- a backstop against a genuinely out-of-range real timestamp.
    expires_at   DateTime,
    revoked      UInt8,
    block_num    UInt64,
    tx_hash      String -- same FixedString-vs-hex0x mismatch as from_addr/to_addr above
) ENGINE = ReplacingMergeTree(block_num)
ORDER BY (protocol, network, scope, to_addr, from_addr);
