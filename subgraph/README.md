# aval-worldchain Subgraph

Indexes `AvalRegistry`, `ReportRegistry`, `PlatformRegistry`, and `PresenceDrip` on World Chain
(`eip155:480`, Graph network slug `worldchain`). See
[`docs/05-graph-data-layer.md`](../docs/05-graph-data-layer.md) for the schema rationale and
[`docs/02-contracts.md`](../docs/02-contracts.md) for the event source of truth.

This directory is **not** an npm workspace member of the root monorepo — it has its own
`package.json` and its own dependency on `@graphprotocol/graph-cli` / `@graphprotocol/graph-ts`,
installed separately:

```bash
cd subgraph
npm install
```

## Before deploying — fill in the placeholders

`subgraph.yaml` ships with every `dataSources[].source.address` set to the zero address and every
`startBlock` set to `0`, each marked `# TODO`. **Both must be filled in before this manifest is
usable**:

- `source.address` — the deployed address of each contract (docs/10-constants.md §7: "TBD at
  deploy").
- `startBlock` — the actual deployment block of each contract, **not `0`**. Indexing a World Chain
  Subgraph from genesis will not finish before a demo (docs/02-contracts.md §6).

## Codegen and build

```bash
npm run codegen   # generates ./generated/ from schema.graphql + abis/*.json — required before build
npm run build     # graph build — compiles src/*.ts to WASM
```

## Deploy

### Subgraph Studio (recommended for the hackathon build)

```bash
graph auth --studio <DEPLOY_KEY>
npm run deploy:studio
```

Note the deployment id (`Qm…`) this prints — that id is `aval.subgraph`'s value
(docs/04-ens.md §2.1, "the verifiability pointer") and what `subgraphDeployment` reports in every
gateway/MCP response.

### Local Graph Node (dev loop)

```bash
npm run create:local
npm run deploy:local
```

## Schema

`schema.graphql` reproduces `Account`, `Vouch`, `FraudEvent`, `Protocol`, `ProtocolDailySnapshot`,
and `AccountStatus` **exactly** as specified in docs/05 §2.1, plus six new entities for the v2/v3
surface this indexer also covers: `Report`, `Rebuttal` (docs/12-reporting.md), `Platform`,
`PlatformVouch`, `ScoreRequest` (docs/13-platforms.md), and `PresenceClaim`
(docs/16-presence-drip.md).

**Expiry is a query-time predicate, everywhere in this schema** — `Vouch.expiresAt` and
`PlatformVouch.expiresAt` are stored; `expired` is never a stored boolean anywhere. A reader filters
with `expiresAt_gt: $now` (docs/05 §2.3). The same principle extends to report weight decay: nothing
here stores a "current" report weight — `@aval/engine` derives it from `Report.filedAt` /
`resolvedAt` / `state` at read time (docs/12 §5).

## What this scaffold intentionally does not index

- **Anchor status** (`Account.isAnchor` / `anchorCheckedAt`): mirrored by a keeper's `AnchorChecked`
  event emitted by a contract outside this task's 4 required data sources (docs/05 §2.4). Defaults
  to `false` / `0` at enrollment; add an `AnchorKeeper` data source to keep it current, and/or rely
  on the engine's own live `getIsUserVerified` multicall for stale entries (docs/05 §2.4).
- **`Protocol.tier1Count` / `tier2Count`**: tier is a whole-graph BFS fixed-point property
  (docs/01-trust-math.md §4.2). A single event handler sees one edge, not the graph, and cannot
  compute it correctly — see the comment on `getOrCreateProtocol()` in `src/helpers.ts`. Left at 0;
  publish these from an off-chain keeper that runs the engine, not from a mapping.
- **`ProtocolDailySnapshot.vouchesExpired` / `promotions` / `demotions`-from-expiry**: expiry fires
  no event (docs/05 §2.3), so there is nothing for a mapping to count; these stay at their initial
  value here rather than being approximated.
- **CredibilityVault bond balances**: not one of this task's 4 data sources; `aval.bonded` (the ENS
  text record) and `aval_report`'s `InsufficientBond` check (in `mcp/`) are both stubbed pending it.

None of the above are silent gaps — each is called out at its point of use (`src/helpers.ts`,
`gateway/src/context.ts`, `mcp/README.md`) rather than only here.
