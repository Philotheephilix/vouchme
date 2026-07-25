# Aval

**Proof of human is a floor. Aval is the ladder.**

World ID's nullifier gives you one account per World ID. Selfie Check gives you one World ID per
human — weakly. Aval closes the gap: humans who are already trusted vouch for other humans, and your
score is a function of *who* vouched for you, weighted by how trusted *they* are.

In Portuguese commercial law an **aval** is a personal guarantee written on someone else's
promissory note. You put your own name on the line for another person. That is what a vouch is here.

## The idea in four rules

1. **Trust flows outward from anchors.** Scores are computed breadth-first from Orb-verified
   accounts, taking contributions only from strictly lower depth. A clique that vouches for itself
   has no member below itself, so it contributes nothing to itself. **The anti-collusion rule and
   the computation order are the same rule** — there is no separate collusion check to evade.
2. **Humans add, platforms subtract.** Apps and services get their own score, granted by the humans
   who vouch for them, and can report people — but no platform can ever vouch for a human.
3. **Money makes claims cost something; it never makes them true.** `AVAL` is a bond for filing and
   contesting reports. 1,000,000 AVAL and no vouches is still score 10.
4. **Creating trust requires a present human; withdrawing it does not.** Vouching is presence-gated
   and unavailable to agents. Revoking and reporting are always available.

A vouch **is** an ENS subname: `carol.alice.aval.eth` means Alice vouched for Carol. Depth in the
trust graph is the label count in the name. The graph lives in a Subgraph, so every score we display
can be independently recomputed by anyone.

## Packages

| Path | What |
|---|---|
| `contracts/` | Foundry — `AvalRegistry`, `ReportRegistry`, `PlatformRegistry`, `CredibilityVault`, `PresenceDrip` (World Chain, chainId 480) |
| `engine/` | The scoring engine. A pure function: `(accounts, edges, reports, anchors, now) → scores`. No I/O, no clock, no state. |
| `subgraph/` | The trust graph itself, indexed from contract events |
| `gateway/` | CCIP-Read resolver — live ENS text records computed at resolution time |
| `mcp/` | `aval-mcp` — MCP server exposing trust queries to agents |
| `app/` | World mini app (Next.js) |

## Quick start

```bash
npm install
npm run build          # build every workspace
npm run typecheck      # tsc --noEmit across all TS packages
npm test               # engine unit tests + forge tests
```

Contracts only:

```bash
cd contracts
forge build
forge test -vvv
```

## Status

Scaffold. Nothing is deployed. See `npm run typecheck` for the current state of the build.

## License

MIT
