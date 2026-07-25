# @aval/mcp

`aval-mcp` — an MCP server that answers *"is there an accountable human behind this counterparty,
and how sure am I?"* in one tool call, over stdio. Points at the Aval trust graph on World Chain,
computed by the same `@aval/engine` the ENS gateway runs, so the two never disagree.

See [`docs/06-mcp-skills.md`](../docs/06-mcp-skills.md) for the full tool reference this package
implements against.

## Install

```bash
npx -y @aval/mcp
```

## Configure

Drop this into `.mcp.json` (Claude Code) or `claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "aval": {
      "command": "npx",
      "args": ["-y", "@aval/mcp"],
      "env": {
        "AVAL_SUBGRAPH_ID": "…",
        "GRAPH_API_KEY": "…",              // or omit and set X402_PRIVATE_KEY instead
        "X402_PRIVATE_KEY": "0x…",
        "X402_CHAIN": "base",
        "AVAL_OPERATOR_ADDRESS": "0x…",    // required for aval_report / aval_request_score
        "WORLDCHAIN_RPC": "https://worldchain-mainnet.g.alchemy.com/public"
      }
    }
  }
}
```

### Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `AVAL_SUBGRAPH_ID` | yes | The deployed `aval-worldchain` Subgraph id. |
| `AVAL_SUBGRAPH_URL` | no | Overrides the derived Gateway URL (Studio / local Graph Node during dev). |
| `GRAPH_API_KEY` | one of these two | Graph Gateway API key — the normal path. |
| `X402_PRIVATE_KEY` | one of these two | x402 fallback: per-query USDC on Base, no account needed (docs/05 §4). |
| `X402_CHAIN` | no | Defaults to `base`. |
| `AVAL_OPERATOR_ADDRESS` | for `aval_report` / `aval_request_score` | The human or platform this server acts on behalf of. |
| `WORLDCHAIN_RPC` | no | For a live `getIsUserVerified` anchor check (see Scope notes). |

**The reusability test this package is built to pass** (docs/06 §6): on a machine that has never
seen this repo, `npx -y @aval/mcp` with *only* `X402_PRIVATE_KEY` set (no Graph API key, no Aval
account) must work.

## The 17 tools

`aval_resolve`, `aval_score`, `aval_explain`, `aval_gate`, `aval_simulate_vouch`, `aval_path`,
`aval_candidates`, `aval_cross_protocol_trust`, `aval_anchor_status`, `aval_history`,
`aval_request_score`, `aval_report`, `aval_report_status`, `aval_platform`,
`aval_pipeline_preview`, `aval_pipeline_deploy`, `aval_query`.

**There is no `aval_vouch` tool, and there never will be** — see the comment at the top of
`src/index.ts`. Vouching requires human presence; an MCP tool that could vouch would be a rented
account. This is not a limitation, it is the product (docs/06 §3).

Every response carries `subgraphDeployment` and `computedAtBlock`. `aval_gate` always returns
`reasons: string[]`, never a bare boolean. `aval_score` includes zero-contribution breakdown rows
with `counted: false` and a `reason` — that's deliberate; excluded contributions are how an agent
learns the anti-collusion rule by observing it, not by reading a doc.

## Scope notes (what this scaffold does *not* implement yet)

Flagged here rather than silently stubbed:

- **x402 payment handshake** (`src/client.ts`'s `X402PaymentHandler`): the interface is real and
  wired into the request flow; the actual USDC-on-Base signing step throws `X402NotImplementedError`
  until it's implemented (or swapped for `@graphprotocol/client-x402`).
- **On-chain writes** (`aval_report`, `aval_request_score`): both compute their real, engine-derived
  answer, but neither submits an actual transaction — that needs a funded signer and contract ABIs
  this task didn't provide. `requestId`/`reportId` are deterministically derived, not on-chain yet.
- **Bond balances** (`aval_report`'s `InsufficientBond` check, `aval.bonded`): `CredibilityVault`
  isn't one of `subgraph/subgraph.yaml`'s four data sources, so unlocked-AVAL balance isn't indexed
  anywhere this server can read it yet.
- **Substreams pipeline generation** (`aval_pipeline_preview` / `_deploy`): implements the documented
  shapes and the "refuse `eventsFound == 0`" safety gate faithfully; the natural-language → manifest
  codegen backend (docs/14-substreams.md) is out of this task's build scope.
- **Circles v2 / ENS adapters** (`aval_cross_protocol_trust`): the Aval side is real; the other two
  legs report zero inbound with a code comment rather than fabricated data, pending the adapter
  deployments in docs/05 §3.3 (deliverable G-3, not this task).

## Development

```bash
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # node's built-in test runner, against dist/**/*.test.js
```

## License

MIT
