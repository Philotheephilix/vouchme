// @aval/subgraph — src/platform-registry.ts
//
// Handlers for every event PlatformRegistry emits (docs/13-platforms.md §8).

import { BigInt, Bytes, log } from "@graphprotocol/graph-ts";
import {
  PlatformRegistered,
  PlatformVouched,
  PlatformVouchRevoked,
  ScoreRequested,
  PlatformBondSlashed,
} from "../generated/PlatformRegistry/PlatformRegistry";
import { Platform, PlatformVouch, ScoreRequest } from "../generated/schema";
import { getOrCreateAccount, platformVouchId } from "./helpers";

function getOrCreatePlatform(address: Bytes): Platform {
  let platform = Platform.load(address);
  if (platform == null) {
    platform = new Platform(address);
    platform.ensName = "";
    platform.metadataURI = Bytes.empty();
    platform.policyURI = null;
    platform.bond = BigInt.zero();
    platform.bondSlashedTotal = BigInt.zero();
    platform.registeredAt = BigInt.zero();
    platform.openReports = 0;
    platform.active = false;
    platform.save();
  }
  return platform as Platform;
}

export function handlePlatformRegistered(event: PlatformRegistered): void {
  const platform = getOrCreatePlatform(event.params.platform);
  platform.ensName = event.params.ensName;
  platform.bond = event.params.bond;
  platform.registeredAt = event.block.timestamp;
  platform.active = true;
  platform.save();
}

export function handlePlatformVouched(event: PlatformVouched): void {
  const human = getOrCreateAccount(event.params.human, event.block.timestamp);
  const platform = getOrCreatePlatform(event.params.platform);

  const id = platformVouchId(event.params.human, event.params.platform);
  let vouch = PlatformVouch.load(id);
  if (vouch == null) {
    vouch = new PlatformVouch(id);
    vouch.issuedAt = event.block.timestamp;
  }
  vouch.human = human.id;
  vouch.platform = platform.id;
  vouch.expiresAt = event.params.expiresAt;
  vouch.revoked = false;
  vouch.revokedAt = null;
  vouch.txHash = event.transaction.hash;
  vouch.save();
}

export function handlePlatformVouchRevoked(event: PlatformVouchRevoked): void {
  const id = platformVouchId(event.params.human, event.params.platform);
  const vouch = PlatformVouch.load(id);
  if (vouch == null) {
    log.warning("PlatformVouchRevoked for unknown vouch {} -> {}", [
      event.params.human.toHexString(),
      event.params.platform.toHexString(),
    ]);
    return;
  }
  vouch.revoked = true;
  vouch.revokedAt = event.block.timestamp;
  vouch.save();
}

export function handleScoreRequested(event: ScoreRequested): void {
  const platform = getOrCreatePlatform(event.params.platform);
  const subject = getOrCreateAccount(event.params.subject, event.block.timestamp);

  const request = new ScoreRequest(event.params.id);
  request.platform = platform.id;
  request.subject = subject.id;
  request.purposeHash = event.params.purposeHash;
  request.at = event.params.at;
  request.txHash = event.transaction.hash;
  request.save();
}

export function handlePlatformBondSlashed(event: PlatformBondSlashed): void {
  const platform = getOrCreatePlatform(event.params.platform);
  platform.bondSlashedTotal = platform.bondSlashedTotal.plus(event.params.amount);
  platform.bond = platform.bond.gt(event.params.amount) ? platform.bond.minus(event.params.amount) : BigInt.zero();
  platform.save();
}
