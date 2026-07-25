// @aval/subgraph — src/aval-registry.ts
//
// Handlers for every event AvalRegistry emits (docs/02-contracts.md §3).
// This is "the entire Subgraph surface" for the core trust graph, per the
// contract's own comment above its event list.

import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";
import {
  Enrolled,
  Vouched,
  Reaffirmed,
  Revoked,
  CredentialRenewed,
  FraudConfirmed,
  SlotPenaltyApplied,
  AttestorSet,
} from "../generated/AvalRegistry/AvalRegistry";
import { Account, FraudEvent, Vouch } from "../generated/schema";
import { credentialLabel, getOrCreateAccount, getOrCreateDailySnapshot, getOrCreateProtocol, vouchId } from "./helpers";

export function handleEnrolled(event: Enrolled): void {
  const account = new Account(event.params.account);
  account.handle = event.params.handle;
  account.enrolledAt = event.params.credentialExpiresAt.minus(BigInt.fromI32(90 * 86400)); // enrolledAt = credentialExpiresAt - 90d, per AvalRegistry.enroll()
  account.credential = credentialLabel(event.params.credential);
  account.credentialExpiresAt = event.params.credentialExpiresAt;
  account.nullifierHash = event.params.nullifierHash;
  account.status = "ACTIVE";
  // isAnchor / anchorCheckedAt: mirrored by a keeper's AnchorChecked event
  // (docs/05-graph-data-layer.md §2.4), which is emitted by a contract
  // outside this scaffold's 4 required data sources (AvalRegistry,
  // ReportRegistry, PlatformRegistry, PresenceDrip) — see
  // subgraph/README.md's scope note. Defaults to false/0 here; a real
  // deployment adds an AnchorKeeper data source to keep this current.
  account.isAnchor = false;
  account.anchorCheckedAt = BigInt.zero();
  account.activeOutboundCount = 0;
  account.activeInboundCount = 0;
  account.slotPenaltyUntil = BigInt.zero();
  // docs/05-graph-data-layer.md §2.1.1: tenure input, maintained by
  // src/presence-drip.ts's handleClaimed/handleTenureZeroed.
  account.epochsClaimed = 0;
  account.lastClaimAt = BigInt.zero();
  account.save();

  const protocol = getOrCreateProtocol();
  protocol.accountCount += 1;
  protocol.save();

  const snapshot = getOrCreateDailySnapshot(event.block.timestamp);
  snapshot.accountCount += 1;
  snapshot.save();
}

export function handleVouched(event: Vouched): void {
  const voucher = getOrCreateAccount(event.params.voucher, event.block.timestamp);
  const vouchee = getOrCreateAccount(event.params.vouchee, event.block.timestamp);

  const id = vouchId(event.params.voucher, event.params.vouchee);
  let vouch = Vouch.load(id);
  if (vouch == null) {
    vouch = new Vouch(id);
  }
  vouch.voucher = voucher.id;
  vouch.vouchee = vouchee.id;
  vouch.issuedAt = event.params.issuedAt;
  vouch.expiresAt = event.params.expiresAt;
  vouch.reaffirmedAt = null;
  vouch.reaffirmCount = 0;
  vouch.revoked = false;
  vouch.revokedAt = null;
  vouch.txHash = event.transaction.hash;
  vouch.save();

  voucher.activeOutboundCount += 1;
  voucher.save();
  vouchee.activeInboundCount += 1;
  vouchee.save();

  const protocol = getOrCreateProtocol();
  protocol.activeVouchCount += 1;
  protocol.save();

  const snapshot = getOrCreateDailySnapshot(event.block.timestamp);
  snapshot.vouchesIssued += 1;
  snapshot.activeVouchCount += 1;
  snapshot.save();
}

export function handleReaffirmed(event: Reaffirmed): void {
  const id = vouchId(event.params.voucher, event.params.vouchee);
  const vouch = Vouch.load(id);
  if (vouch == null) {
    log.warning("Reaffirmed for unknown vouch {} -> {}", [
      event.params.voucher.toHexString(),
      event.params.vouchee.toHexString(),
    ]);
    return;
  }
  vouch.expiresAt = event.params.expiresAt;
  vouch.reaffirmedAt = event.block.timestamp;
  vouch.reaffirmCount += 1;
  vouch.save();
}

export function handleRevoked(event: Revoked): void {
  const id = vouchId(event.params.voucher, event.params.vouchee);
  const vouch = Vouch.load(id);
  if (vouch == null) {
    log.warning("Revoked for unknown vouch {} -> {}", [
      event.params.voucher.toHexString(),
      event.params.vouchee.toHexString(),
    ]);
    return;
  }
  vouch.revoked = true;
  vouch.revokedAt = event.params.at;
  vouch.save();

  const voucher = Account.load(event.params.voucher);
  if (voucher != null) {
    if (voucher.activeOutboundCount > 0) voucher.activeOutboundCount -= 1;
    voucher.save();
  }
  const vouchee = Account.load(event.params.vouchee);
  if (vouchee != null) {
    if (vouchee.activeInboundCount > 0) vouchee.activeInboundCount -= 1;
    vouchee.save();
  }

  const protocol = getOrCreateProtocol();
  if (protocol.activeVouchCount > 0) protocol.activeVouchCount -= 1;
  protocol.save();

  const snapshot = getOrCreateDailySnapshot(event.block.timestamp);
  snapshot.vouchesRevoked += 1;
  if (snapshot.activeVouchCount > 0) snapshot.activeVouchCount -= 1;
  snapshot.save();
}

export function handleCredentialRenewed(event: CredentialRenewed): void {
  const account = getOrCreateAccount(event.params.account, event.block.timestamp);
  account.credentialExpiresAt = event.params.credentialExpiresAt;
  // status (GRACE/SUSPENDED) is derived at query time from
  // credentialExpiresAt (docs/05 §2.3), not written here — a renewal just
  // clears the underlying reason it would have been derived that way.
  account.status = "ACTIVE";
  account.save();
}

export function handleFraudConfirmed(event: FraudConfirmed): void {
  const account = getOrCreateAccount(event.params.account, event.block.timestamp);
  account.status = "FRAUDULENT";
  account.save();

  // FraudEvent.id = the transaction hash: confirmFraud() emits exactly one
  // FraudConfirmed per call, before the SlotPenaltyApplied loop that
  // follows it in the same transaction (docs/02-contracts.md §3.6) — see
  // handleSlotPenaltyApplied below, which correlates back to this id.
  const fraudEvent = new FraudEvent(event.transaction.hash);
  fraudEvent.account = account.id;
  fraudEvent.reason = event.params.reason;
  fraudEvent.at = event.params.at;
  fraudEvent.penalizedVouchers = [];
  fraudEvent.save();

  const snapshot = getOrCreateDailySnapshot(event.block.timestamp);
  snapshot.demotions += 1;
  snapshot.save();
}

export function handleSlotPenaltyApplied(event: SlotPenaltyApplied): void {
  const voucher = getOrCreateAccount(event.params.voucher, event.block.timestamp);
  voucher.slotPenaltyUntil = event.params.until;
  voucher.save();

  // Correlate back to the FraudConfirmed emitted earlier in the same
  // transaction, if any (confirmFraud's penalty loop; see
  // handleFraudConfirmed). SlotPenaltyApplied can also fire from other
  // paths in principle, so a miss here is expected, not an error.
  const fraudEvent = FraudEvent.load(event.transaction.hash);
  if (fraudEvent != null) {
    const penalized = fraudEvent.penalizedVouchers;
    penalized.push(event.params.voucher);
    fraudEvent.penalizedVouchers = penalized;
    fraudEvent.save();
  }
}

export function handleAttestorSet(event: AttestorSet): void {
  // Attestor set membership is operational metadata (which backend keys
  // may sign enrollment/vouch attestations) — it is not one of the
  // entities in docs/05-graph-data-layer.md §2.1 and has no scoring
  // relevance, so this handler intentionally does not write an entity.
  // It exists so "every event the contract emits has a handler" holds
  // literally, and so a change to the attestor set is at least visible in
  // the indexer's logs.
  log.info("AttestorSet: attestor={} enabled={}", [
    event.params.attestor.toHexString(),
    event.params.enabled ? "true" : "false",
  ]);
}
