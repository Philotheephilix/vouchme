// @aval/subgraph — src/helpers.ts
//
// Shared entity loaders used by every mapping file. Kept separate so each
// event handler file stays focused on "what does this one event mean,"
// per docs/02-contracts.md §1's design rule: the contract stores facts,
// mappings just record them — no scoring logic belongs here (that's
// @aval/engine's job, run off-chain by the gateway and aval-mcp).

import { BigInt, Bytes, ByteArray, crypto } from "@graphprotocol/graph-ts";
import { Account, Protocol, ProtocolDailySnapshot } from "../generated/schema";

export const PROTOCOL_ID = "aval";
const SECONDS_PER_DAY = BigInt.fromI32(86400);

// docs/05-graph-data-layer.md §2.1: credential is one of "selfie-check" |
// "orb" | "document". On-chain it is emitted as keccak256(label)
// (docs/02-contracts.md §3.1's comment: `bytes32 credential, //
// keccak("selfie-check") | keccak("orb")`), so the mapping recovers the
// label by comparing against the keccak256 of each known literal rather
// than storing the raw hash — the whole point of the Subgraph is that
// `aval.credential` reads as a string, not a hash.
const CREDENTIAL_LABELS = ["selfie-check", "orb", "document"];

export function credentialLabel(hash: Bytes): string {
  for (let i = 0; i < CREDENTIAL_LABELS.length; i++) {
    const label = CREDENTIAL_LABELS[i];
    const candidate = crypto.keccak256(ByteArray.fromUTF8(label));
    if (Bytes.fromByteArray(candidate).equals(hash)) {
      return label;
    }
  }
  // Unknown credential hash — surfaced as the raw hex rather than dropped,
  // so an unexpected credential type is visible in a query instead of
  // silently miscategorized.
  return hash.toHexString();
}

export function vouchId(voucher: Bytes, vouchee: Bytes): Bytes {
  // Schema comment (docs/05 §2.1): "id: Bytes! # keccak(voucher ++ vouchee)".
  const concatenated = voucher.concat(vouchee);
  return Bytes.fromByteArray(crypto.keccak256(concatenated));
}

export function platformVouchId(human: Bytes, platform: Bytes): Bytes {
  return Bytes.fromByteArray(crypto.keccak256(human.concat(platform)));
}

export function getOrCreateAccount(address: Bytes, timestamp: BigInt): Account {
  let account = Account.load(address);
  if (account == null) {
    // Defensive fallback: every real path to an Account is `Enrolled`
    // firing first (AvalRegistry.enroll() requires no prior state), but a
    // handler that references an account it hasn't seen yet (e.g. a
    // PlatformVouch naming a human before indexing catches up in a
    // reorg-adjacent edge case) should not crash — it creates a minimal
    // placeholder rather than reverting the whole mapping.
    account = new Account(address);
    account.handle = "";
    account.enrolledAt = timestamp;
    account.credential = "";
    account.credentialExpiresAt = BigInt.zero();
    account.nullifierHash = BigInt.zero();
    account.status = "ACTIVE";
    account.isAnchor = false;
    account.anchorCheckedAt = BigInt.zero();
    account.activeOutboundCount = 0;
    account.activeInboundCount = 0;
    account.slotPenaltyUntil = BigInt.zero();
    account.save();
  }
  return account as Account;
}

export function getOrCreateProtocol(): Protocol {
  let protocol = Protocol.load(PROTOCOL_ID);
  if (protocol == null) {
    protocol = new Protocol(PROTOCOL_ID);
    protocol.accountCount = 0;
    protocol.activeVouchCount = 0;
    protocol.anchorCount = 0;
    // tier1Count / tier2Count are NOT maintained by any mapping in this
    // package: tier is a whole-graph BFS fixed-point property
    // (docs/01-trust-math.md §4.2), which an event handler — triggered by
    // one edge at a time, with no view of the rest of the graph — cannot
    // compute correctly. They are initialized to 0 and left alone here;
    // an off-chain keeper (or @aval/engine itself, run periodically) is
    // the correct place to publish these two counts, matching how
    // `isAnchor` mirroring already works (docs/05 §2.4).
    protocol.tier1Count = 0;
    protocol.tier2Count = 0;
    protocol.save();
  }
  return protocol as Protocol;
}

export function dayIndex(timestamp: BigInt): i32 {
  return timestamp.div(SECONDS_PER_DAY).toI32();
}

export function getOrCreateDailySnapshot(timestamp: BigInt): ProtocolDailySnapshot {
  const day = dayIndex(timestamp);
  const id = day.toString();
  let snapshot = ProtocolDailySnapshot.load(id);
  if (snapshot == null) {
    snapshot = new ProtocolDailySnapshot(id);
    snapshot.day = day;
    snapshot.accountCount = 0;
    snapshot.activeVouchCount = 0;
    snapshot.vouchesIssued = 0;
    snapshot.vouchesRevoked = 0;
    snapshot.vouchesExpired = 0; // never incremented by any handler — see docs/05 §2.3: expiry fires no event, so it is a query-time predicate, not a countable event
    snapshot.promotions = 0; // same caveat as Protocol.tier1Count/tier2Count above — not derivable from a single event
    snapshot.demotions = 0;
    snapshot.save();
  }
  return snapshot as ProtocolDailySnapshot;
}
