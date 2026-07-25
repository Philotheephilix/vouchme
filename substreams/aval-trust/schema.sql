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
CREATE TABLE trust_edges (
    protocol     LowCardinality(String),
    network      LowCardinality(String),
    from_addr    FixedString(20),
    to_addr      FixedString(20),
    kind         Enum8('VOUCH'=0,'REVOKE'=1,'REAFFIRM'=2,'REPORT'=3,'REPORT_RESOLVED'=4),
    weight_raw   Decimal(38, 18),
    issued_at    DateTime,
    expires_at   DateTime,
    revoked      UInt8,
    block_num    UInt64,
    tx_hash      FixedString(32)
) ENGINE = ReplacingMergeTree(block_num)
ORDER BY (protocol, to_addr, from_addr);

-- The one query the engine makes (docs/14-substreams.md §4): the whole graph,
-- one scan, ~10ms at 10^6 edges instead of ~100 paginated GraphQL round trips.
--
-- SELECT to_addr, from_addr, weight_raw, expires_at
-- FROM trust_edges FINAL
-- WHERE protocol = 'aval' AND revoked = 0 AND expires_at > now() AND kind = 'VOUCH'
--
-- No terminating punctuation on the line above, on purpose. substreams-sink-sql splits
-- schema.sql into statements on that punctuation mark without being comment-aware, so a stray
-- occurrence of it inside a trailing comment reopens a second, comment-only statement that
-- ClickHouse rejects with code 62 (empty query). Found by actually running `setup`, twice: once
-- for the original doc-comment query at the bottom of this file, and again when the first fix
-- attempt re-explained the bug using the very character it was warning about.
