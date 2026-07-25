// @aval/subgraph — src/presence-drip.ts
//
// Handlers for every event PresenceDrip emits (docs/16-presence-drip.md §6).
// `PresenceClaim.totalEpochs` on an account's most recent claim is that
// account's current `epochsClaimed` — the input to `tenureCenti()`
// (docs/16 §4) — without adding a field to the exact Account entity from
// docs/05 §2.1 (see schema.graphql's comment on PresenceClaim).

import { BigInt, log } from "@graphprotocol/graph-ts";
import { Claimed, TenureZeroed, DripRateChanged } from "../generated/PresenceDrip/PresenceDrip";
import { PresenceClaim } from "../generated/schema";
import { getOrCreateAccount } from "./helpers";

export function handleClaimed(event: Claimed): void {
  const account = getOrCreateAccount(event.params.account, event.block.timestamp);

  const claim = new PresenceClaim(event.transaction.hash.concatI32(event.logIndex.toI32()));
  claim.account = account.id;
  claim.amount = event.params.amount;
  claim.epochs = event.params.epochs;
  claim.totalEpochs = event.params.totalEpochs;
  claim.at = event.block.timestamp;
  claim.txHash = event.transaction.hash;
  claim.save();
}

export function handleTenureZeroed(event: TenureZeroed): void {
  // Tenure is derived from the most recent PresenceClaim.totalEpochs
  // (docs/16 §4.3: "Confirmed fraud zeroes tenure — the one irreversible
  // tenure penalty in the system"). Recorded as a zero-epoch claim so the
  // derivation ("latest claim wins") keeps working with no special case
  // in the reader — a real deployment's PresenceDrip contract resets
  // `epochsClaimed` to 0 on-chain at the same moment this event fires, so
  // `totalEpochs: 0` here matches on-chain state exactly, not just the
  // Subgraph's convenience.
  const account = getOrCreateAccount(event.params.account, event.block.timestamp);
  const claim = new PresenceClaim(event.transaction.hash.concatI32(event.logIndex.toI32()));
  claim.account = account.id;
  claim.amount = BigInt.zero();
  claim.epochs = BigInt.zero();
  claim.totalEpochs = BigInt.zero();
  claim.at = event.block.timestamp;
  claim.txHash = event.transaction.hash;
  claim.save();
}

export function handleDripRateChanged(event: DripRateChanged): void {
  // Protocol-wide emission-rate metadata, not per-account state — no
  // entity in docs/05 §2.1's schema (nor this task's added entities)
  // models it. Logged so the event is still visible to an indexer
  // operator; scoring never depends on it (docs/16 §4: the tenure curve
  // is a pure function of `epochsClaimed`, independent of pool size).
  log.info("DripRateChanged: poolPerEpoch={} activeClaimants={}", [
    event.params.poolPerEpoch.toString(),
    event.params.activeClaimants.toString(),
  ]);
}
