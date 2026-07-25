// @aval/gateway — src/subgraph.ts
//
// There is no deployed Aval Subgraph for this task (deployments/worldchain-sepolia.json's own
// notes). This module used to hold a paginated GraphQL client against one; that implementation
// has moved to src/chain.ts, which reads the exact same shapes directly off World Chain Sepolia
// (AvalRegistry events + GenesisAnchorBook.getIsUserVerified) instead. Kept as a thin re-export so
// every existing `import ... from "./subgraph.js"` (context.ts, resolve.ts, this package's tests)
// keeps working unchanged — the module name is legacy, the implementation underneath it is live
// chain data, honestly reported as `direct-chain-read:4801` wherever a deployment id is shown
// (never a fabricated IPFS hash).

export {
  getTrustGraph,
  getNamingGraph,
  clearTrustGraphCache,
  CHAIN_PROVENANCE,
  type AccountStatus,
  type InboundEdge,
  type SubgraphAccount,
  type TrustGraphSnapshot,
  type NamingAccount,
  type NamingEdge,
  type NamingSnapshot,
  type ChainClientConfig,
  type ChainClientConfig as SubgraphClientConfig,
  type GetTrustGraphOptions,
} from "./chain.js";
