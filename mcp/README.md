# @vouchme/mcp

`vouchme-mcp` — an MCP server that answers *"is there an accountable human behind this counterparty,
and how sure am I?"* in one tool call, over stdio. Points at the VouchMe trust graph on World Chain,
computed by the same `@vouchme/engine` the ENS gateway runs, so the two never disagree.

See [`docs/06-mcp-skills.md`](../docs/06-mcp-skills.md) for the full tool reference this package
implements against.

## Install

```bash
npx -y @vouchme/mcp
```

## Configure

Drop this into `.mcp.json` (Claude Code) or `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "vouchme": {
      "command": "npx",
      "args": ["-y", "@vouchme/mcp"],
      "env": {
        "VOUCHME_SUBGRAPH_ID": "…",
        "GRAPH_API_KEY": "…",              // or omit and set X402_PRIVATE_KEY instead
        "X402_PRIVATE_KEY": "0x…",
        "X402_CHAIN": "base",
        "VOUCHME_OPERATOR_ADDRESS": "0x…",    // required for vouchme_report / vouchme_request_score
        "WORLDCHAIN_RPC": "https://worldchain-mainnet.g.alchemy.com/public"
      }
    }
  }
}
```

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `VOUCHME_SUBGRAPH_ID` | yes | The deployed `vouchme-worldchain` Subgraph id. |
| `VOUCHME_SUBGRAPH_URL` | no | Overrides the derived Gateway URL (Studio / local Graph Node during dev). |
| `GRAPH_API_KEY` | one of these two | Graph Gateway API key — the normal path. |
| `X402_PRIVATE_KEY` | one of these two | x402 fallback: per-query USDC on Base, no account needed (docs/05 §4). |
| `X402_CHAIN` | no | Defaults to `base`. |
| `VOUCHME_OPERATOR_ADDRESS` | for `vouchme_report` / `vouchme_request_score` | The human or platform this server acts on behalf of. Both tools refuse with `NoOperator` when unset. |
| `WORLDCHAIN_RPC` | no | For a live `getIsUserVerified` anchor check (see Scope notes). |
| `SUBSTREAMS_API_TOKEN`, `SUBSTREAMS_ENDPOINT` | for `vouchme_pipeline_deploy` | Both required, or the tool refuses with `NotConfigured` — see Scope notes. |

**The reusability test this package is built to pass** (docs/06 §6): on a machine that has never
seen this repo, `npx -y @vouchme/mcp` with *only* `X402_PRIVATE_KEY` set (no Graph API key, no VouchMe
account) must work.

## The 17 tools

`vouchme_resolve`, `vouchme_score`, `vouchme_explain`, `vouchme_gate`, `vouchme_simulate_vouch`, `vouchme_path`,
`vouchme_candidates`, `vouchme_cross_protocol_trust`, `vouchme_anchor_status`, `vouchme_history`,
`vouchme_request_score`, `vouchme_report`, `vouchme_report_status`, `vouchme_platform`,
`vouchme_pipeline_preview`, `vouchme_pipeline_deploy`, `vouchme_query`.

**There is no `vouchme_vouch` tool, and there never will be** — see the comment at the top of
`src/index.ts`. Vouching requires human presence; an MCP tool that could vouch would be a rented
account. This is not a limitation, it is the product (docs/06 §3).

Every response carries `subgraphDeployment` and `computedAtBlock`. `vouchme_gate` always returns
`reasons: string[]`, never a bare boolean. `vouchme_score` includes zero-contribution breakdown rows
with `counted: false` and a `reason` — that's deliberate; excluded contributions are how an agent
learns the anti-collusion rule by observing it, not by reading a doc.

## Scope notes (what this scaffold does *not* implement yet)

Flagged here rather than silently stubbed:

- **x402 payment handshake** (`src/client.ts`'s `X402PaymentHandler`): the interface is real and
  wired into the request flow; the actual USDC-on-Base signing step throws `X402NotImplementedError`
  until it's implemented (or swapped for `@graphprotocol/client-x402`).
- **On-chain writes** (`vouchme_report`, `vouchme_request_score`): both refuse with a named `NoOperator`
  error when `VOUCHME_OPERATOR_ADDRESS` isn't set (docs/06's signature for each has no explicit
  requester/reporter parameter, so attribution has to come from server config). When configured,
  both compute their real, engine-derived answer, but neither submits an actual transaction — that
  needs a funded signer and contract ABIs this task didn't provide. `requestId`/`reportId` are
  deterministically derived, not on-chain yet.
- **Bond balances** (`vouchme_report`'s `InsufficientBond` check, `vouchme.bonded`): `CredibilityVault`
  isn't one of `subgraph/subgraph.yaml`'s four data sources, so unlocked-VOUCHME balance isn't indexed
  anywhere this server can read it yet.
- **Substreams pipeline generation** (`vouchme_pipeline_preview` / `_deploy`): implements the documented
  shapes and the "refuse `eventsFound == 0`" safety gate faithfully; `_deploy` additionally refuses
  with a named `NotConfigured` error when `SUBSTREAMS_API_TOKEN` / `SUBSTREAMS_ENDPOINT` aren't set,
  rather than reporting a fake `sinkStatus`. The natural-language → manifest codegen backend
  (docs/14-substreams.md) is out of this task's build scope.
- **Cross-protocol trust** (`vouchme_cross_protocol_trust`): **real, live, multi-protocol.** It runs
  ONE query against the standardized `trust_edges` store that the composable Substreams package
  writes (`substreams/service`'s `GET /cross-protocol`), returning edges from VouchMe on World Chain
  and EAS on Base / Optimism / Arbitrum / Ethereum in a single identical shape — see
  [`docs/17-trust-graph-standard.md`](../docs/17-trust-graph-standard.md). The tool contains **no
  per-protocol branching**; registering another protocol changes neither this file nor its config.
  Two honest edges to know about:
  - The VouchMe-specific engine read (a chunked `eth_getLogs` replay) attaches the normalized
    `vouchMeWeight` and is bounded by `VOUCHME_ENGINE_TIMEOUT_MS`. On timeout the tool still returns
    every standardized edge — VouchMe's included, since the store carries them too — and names the
    skipped enrichment in `unavailable`.
  - **Circles v2 is specified but not indexed**: Gnosis has no Firehose/Substreams endpoint from
    any provider (`substreams/PROOF.md` §7.1, §11.4). Its adapter profile is written out as a
    worked example in docs/17 §7; it cannot be run.

## Development

```bash
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # node's built-in test runner, against dist/**/*.test.js
```

## License

MIT
