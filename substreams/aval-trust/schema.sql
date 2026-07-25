-- trust_edges — docs/14-substreams.md §4, verbatim.
--
-- ORDER BY (protocol, to_addr, from_addr) because the engine's hot query is
-- "all inbound edges for every account" — the BFS inner loop
-- (docs/05-graph-data-layer.md §2.2 / §3.2). ReplacingMergeTree(block_num)
-- plus `FINAL` at query time is the standard ClickHouse idiom for a table fed
-- by insert-only Database Changes CDC (substreams-sink-sql on ClickHouse is
-- insert-only — see substreams-sql skill, "Capability matrix"): every state
-- change (VOUCH / REAFFIRM / REVOKE) is inserted as a new row for the same
-- (protocol, to_addr, from_addr) key with a higher block_num, and a merge (or
-- `FINAL`) keeps only the highest block_num per key.
--
-- The engine's one hot query, for reference (not executed here — see PROOF.md for a live
-- example): select to_addr, from_addr, weight_raw, expires_at from trust_edges final where
-- protocol equals the target protocol, revoked is false, expires_at is in the future, and kind
-- is VOUCH.
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
    -- `expires_at`: `4294967295` (2106-02-07 06:28:15, `DateTime`'s own maximum — see
    -- `clamp_unix_timestamp` in `src/lib.rs`) is a CLAMP-SAFETY CEILING, not a "never expires"
    -- sentinel encoding any real protocol convention. It appears whenever the decoded word does
    -- not represent a real timestamp at all for the protocol in question — concretely, on the
    -- Base/EAS demo in PROOF.md §7, where the one non-indexed word in `Attested(...)` is the
    -- attestation's `uid` (a content hash), not a timing field. EAS's real `expirationTime` lives
    -- in contract storage, not the event log, and is not decoded here. Do not read this value as
    -- "this edge never expires" — for that protocol/mapping, this column has no real data behind
    -- it, full stop. Contrast Circles v2's `Trust.expiryTime`, which genuinely IS a timestamp
    -- word (verified against real logs, PROOF.md) and decodes to a meaningful `expires_at`.
    expires_at   DateTime,
    revoked      UInt8,
    block_num    UInt64,
    tx_hash      String -- same FixedString-vs-hex0x mismatch as from_addr/to_addr above
) ENGINE = ReplacingMergeTree(block_num)
ORDER BY (protocol, to_addr, from_addr);
