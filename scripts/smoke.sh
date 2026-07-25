#!/usr/bin/env bash
# Full smoke test. Every claim this repo makes, verified by running it.
# Usage: bash scripts/smoke.sh
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)

PASS=0; FAIL=0
declare -a FAILED

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
ok()   { PASS=$((PASS+1)); printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); FAILED+=("$1"); printf '  \033[31mFAIL\033[0m  %s\n' "$1"; }
# Run each check in a SUBSHELL: without it a `cd` inside one check (contracts,
# subgraph) leaks into every later one, and the npm workspace steps then run from
# outside the workspace root and fail in a way that looks like a broken package.
check(){ if ( cd "$ROOT" && eval "$2" ) >/tmp/smoke.$$ 2>&1; then ok "$1"; else bad "$1"; tail -6 /tmp/smoke.$$ | sed 's/^/        /'; fi; }

# ── 1. static ────────────────────────────────────────────────────────────────
step "1. Typecheck and build"
check "typecheck (engine, gateway, mcp, app)" "npm run typecheck"
check "build (all workspaces)"                "npm run build"

# ── 2. unit tests ────────────────────────────────────────────────────────────
step "2. Unit tests"
for w in engine gateway mcp; do
  check "@aval/$w tests" "npm test --workspace=@aval/$w"
done

# ── 3. contracts ─────────────────────────────────────────────────────────────
step "3. Contracts"
check "forge build" "cd '$ROOT/contracts' && forge build"
check "forge test"  "cd '$ROOT/contracts' && forge test"

# ── 4. subgraph ──────────────────────────────────────────────────────────────
step "4. Subgraph"
check "graph codegen" "cd '$ROOT/subgraph' && npx --no-install graph codegen"
check "graph build"   "cd '$ROOT/subgraph' && npx --no-install graph build"

# ── 5. gateway boots and serves ──────────────────────────────────────────────
step "5. Gateway"
# 5a. missing required config must fail fast and NAME the variable, not stack-trace.
GWERR=$(cd "$ROOT" && AVAL_SUBGRAPH_URL=http://localhost:9/dummy PORT=8788 \
  timeout 10 node gateway/dist/server.js 2>&1 | head -3)
printf '%s' "$GWERR" | grep -q 'GATEWAY_SIGNER_PRIVATE_KEY' \
  && ok "missing config fails fast naming the variable" \
  || bad "startup error did not name the missing variable: $GWERR"

# 5b. with config present it serves.
DEV_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
(cd "$ROOT" && AVAL_SUBGRAPH_URL=http://localhost:9/dummy PORT=8788 \
  GATEWAY_SIGNER_PRIVATE_KEY=$DEV_KEY \
  node gateway/dist/server.js >/tmp/smoke-gw.$$ 2>&1 &) ; sleep 3
if curl -fsS --max-time 5 http://localhost:8788/health >/tmp/smoke-gwh.$$ 2>&1; then
  ok "GET /health -> 200 ($(head -c 80 /tmp/smoke-gwh.$$))"
else
  bad "GET /health"; tail -5 /tmp/smoke-gw.$$ | sed 's/^/        /'
fi
pkill -f "node gateway/dist/server.js" 2>/dev/null

# ── 6. mcp speaks stdio ──────────────────────────────────────────────────────
# The SDK requires the `initialized` notification before it will answer tools/list,
# and it closes on EOF, so a raw stdio pipe cannot drive it. Use the package's own
# test, which drives a real SDK client over a real transport.
step "6. MCP server"
if ( cd "$ROOT" && npm test --workspace=@aval/mcp ) >/tmp/smoke-mcp.$$ 2>&1; then
  grep -qE '# (pass|tests) [1-9]' /tmp/smoke-mcp.$$ \
    && ok "stdio handshake: 17 tools, aval_vouch absent (asserted in-suite)" \
    || bad "mcp suite ran but asserted nothing"
else
  bad "mcp stdio suite"; tail -8 /tmp/smoke-mcp.$$ | sed 's/^/        /'
fi
# Independent check that the tool is genuinely absent from the source of truth.
grep -rq '"aval_vouch"\|aval_vouch:' mcp/src/tools/ 2>/dev/null \
  && bad "aval_vouch found in mcp/src/tools — vouching requires human presence" \
  || ok "aval_vouch absent from the tool registry"

# ── 7. app serves every route ────────────────────────────────────────────────
step "7. App"
pkill -f "next start" 2>/dev/null; sleep 1
(cd "$ROOT/app" && npx next start -p 3000 >/tmp/smoke-app.$$ 2>&1 &) ; sleep 8
for r in / /enroll /vouch /explore /reports /platform /agents; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:3000$r")
  [ "$code" = "200" ] && ok "GET $r -> 200" || bad "GET $r -> $code"
done
# Resolve a real address from the fixture rather than inventing one — an
# invented address correctly 404s, which would look like a route failure.
ADDR=$(curl -s --max-time 10 http://localhost:3000/api/identity/carol.alice.aval.eth \
       | grep -oE '0x[0-9a-fA-F]{40}' | head -1)
[ -n "$ADDR" ] && ok "identity resolves carol.alice.aval.eth -> ${ADDR:0:10}…" \
               || bad "could not resolve a fixture address"

for r in /api/health "/api/identity/carol.alice.aval.eth" "/api/score/$ADDR" "/api/explain/$ADDR"; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:3000$r")
  [ "$code" = "200" ] && ok "GET $r -> 200" || bad "GET $r -> $code"
done

# An address that is not in the graph must 404, not 200 with an invented score.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 \
  "http://localhost:3000/api/score/0x1111111111111111111111111111111111111111")
[ "$code" = "404" ] && ok "unknown address -> 404 (never a fabricated score)" \
                    || bad "unknown address -> $code, want 404"
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST \
  -H 'content-type: application/json' \
  -d '{"address":"0x1111111111111111111111111111111111111111","policy":{"minTier":1}}' \
  http://localhost:3000/api/gate)
[ "$code" = "200" ] && ok "POST /api/gate -> 200" || bad "POST /api/gate -> $code"

# malformed input must be a clean 400, not a 500
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:3000/api/score/%")
[ "$code" = "400" ] && ok "GET /api/score/% -> 400 (not 500)" || bad "malformed percent-encoding -> $code, want 400"

# ── 8. spec invariants, asserted against the real engine ─────────────────────
step "8. Spec invariants (live engine)"
check "I-2/I-17/I-21 etc. via engine suite" "node --test engine/dist/*.test.js"

# ── summary ──────────────────────────────────────────────────────────────────
pkill -f "next start" 2>/dev/null
rm -f /tmp/smoke.$$ /tmp/smoke-gw.$$ /tmp/smoke-gwh.$$ /tmp/smoke-app.$$
printf '\n\033[1m═══ %d passed, %d failed ═══\033[0m\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then printf '  %s\n' "${FAILED[@]}"; exit 1; fi
