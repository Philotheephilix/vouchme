// @aval/gateway — src/subgraph.ts
//
// There is no deployed Aval Subgraph (deployments/worldchain-sepolia.json's own notes):
// src/chain.ts reads the same shapes directly off World Chain Sepolia (AvalRegistry events +
// GenesisAnchorBook.getIsUserVerified). This module is a thin re-export of it, so the module name
// is legacy while the implementation underneath is live chain data, reported as
// `direct-chain-read:4801` wherever a deployment id is shown (never a fabricated IPFS hash).

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
