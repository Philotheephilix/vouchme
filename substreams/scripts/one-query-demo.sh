#!/usr/bin/env bash
# substreams/scripts/one-query-demo.sh
#
# The trust-graph v0.2.0 payoff, end to end, in one command:
#   ONE standardized query returning trust edges across 2 protocols on 5 chains,
#   every row produced by ONE .spkg differing only in `--network`.
#
#   ./substreams/scripts/one-query-demo.sh            # query what is already indexed
#   ./substreams/scripts/one-query-demo.sh --reindex  # re-run all five live streams first
#
# Requires: ClickHouse at :8123 (docker container `vouchme-substreams-clickhouse`).
# --reindex additionally requires the `substreams-sink-sql` binary and SUBSTREAMS_API_TOKEN.
set -euo pipefail

CH="${CLICKHOUSE_HTTP_URL:-http://127.0.0.1:8123}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$HERE/../vouchme-trust"
ch() { curl -sS "$CH/" --data "$1"; }

if [[ "${1:-}" == "--reindex" ]]; then
  DSN="clickhouse://default:@localhost:9000/default"
  set -a; . "$HERE/../../.env"; set +a
  echo "==> rebuilding the standardized table from live Substreams"
  ch 'DROP TABLE IF EXISTS trust_edges' >/dev/null
  ch 'DROP TABLE IF EXISTS cursors' >/dev/null
  substreams-sink-sql setup "$DSN" "$PKG/substreams.sink.yaml" >/dev/null 2>&1 || true

  # network:endpoint:start:stop — the ONLY thing that differs per chain. Same .spkg throughout.
  #
  # One network failing must not abort the rest: the free Substreams tier caps concurrent
  # requests (SUBSTREAMS_MAX_REQUESTS=2), so a run can fail transiently and succeed on retry.
  # Each network reports its own PASS/FAIL and row delta rather than dying silently under `set -e`.
  failed=()
  for spec in \
    "worldchain:worldchain:32833177:32836700" \
    "base:base:49110120:49110210" \
    "optimism:optimism:154673910:154673930" \
    "arbitrum:arbitrum:487448500:487448540" \
    "mainnet:mainnet:25601310:25601322"
  do
    IFS=: read -r net ep from to <<<"$spec"
    ok=""
    for attempt in 1 2; do
      # Each adapter profile hashes to a different module hash, and the sink resolves cursors by
      # highest block — so a stale cursor from the previous network would be refused. These are
      # bounded backfills with nothing to resume, so clearing the cursor between them is correct.
      ch 'TRUNCATE TABLE cursors' >/dev/null
      if substreams-sink-sql run "$DSN" "$PKG/substreams.sink.yaml" "$from:$to" \
           --network "$net" -e "$ep" --undo-buffer-size=1 --development-mode \
           --batch-block-flush-interval=1 >/dev/null 2>&1
      then ok=1; break; fi
      sleep 3
    done
    rows=$(ch "SELECT count() FROM trust_edges FINAL WHERE network = '$net'" | tr -d '[:space:]')
    if [[ -n "$ok" ]]; then
      printf '    PASS  --network %-11s (%s:%s)  %s edges\n' "$net" "$from" "$to" "$rows"
    else
      printf '    FAIL  --network %-11s (%s:%s)  %s edges — see the run output for the real error\n' \
        "$net" "$from" "$to" "$rows"
      failed+=("$net")
    fi
  done
  [[ ${#failed[@]} -gt 0 ]] && echo "    (${#failed[@]} network(s) failed: ${failed[*]})"
  echo
fi

cat <<'BANNER'
────────────────────────────────────────────────────────────────────────────────
 ONE standardized query · 2 protocols · 5 chains · 1 .spkg
 The query below names no protocol and no chain. It does not need to know
 which exist — that is the entire point of the shared schema.
────────────────────────────────────────────────────────────────────────────────
BANNER

ch "
SELECT protocol, network, kind, from_addr, to_addr, substring(scope,1,10) AS scope,
       issued_at, expires_at, revoked, block_num
FROM trust_edges FINAL
ORDER BY protocol, network, block_num
FORMAT PrettyCompactMonoBlock"

echo
echo "── coverage ────────────────────────────────────────────────────────────────────"
ch "
SELECT protocol, network, count() AS edges,
       countIf(kind = 'VOUCH')  AS vouches,
       countIf(kind = 'REVOKE') AS revokes,
       min(block_num) AS from_block, max(block_num) AS to_block
FROM trust_edges FINAL
GROUP BY protocol, network
ORDER BY protocol, network
FORMAT PrettyCompactMonoBlock"

echo
echo "── cross-protocol analysis: every subject asserted about, on any protocol ──────"
echo "   (uses the standard's liveness predicate — note the perpetual-sentinel arm)"
ch "
SELECT to_addr AS subject,
       count() AS live_inbound_edges,
       arrayStringConcat(arraySort(groupUniqArray(concat(protocol, ':', network))), ', ') AS asserted_on
FROM trust_edges FINAL
WHERE revoked = 0 AND (expires_at = toDateTime(0) OR expires_at > now())
GROUP BY subject
ORDER BY live_inbound_edges DESC, subject
FORMAT PrettyCompactMonoBlock"

echo
echo "Verify every row against independent, non-Firehose RPC reads:"
echo "  node substreams/scripts/crosscheck-trust-edges.mjs"
