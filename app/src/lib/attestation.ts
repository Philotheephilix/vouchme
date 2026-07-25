/**
 * app/src/lib/attestation.ts
 *
 * Server-only EIP-712 signing for the two attestation kinds this app issues:
 *   - `AvalRegistry.EnrollAttestation` / `VouchAttestation`
 *   - `PresenceDrip.TierAttestation`
 *
 * Domain, types and field order are copied verbatim from `scripts/live-scenario.mjs` (Aval
 * registry) and `contracts/src/PresenceDrip.sol`'s own `TIER_TYPEHASH` (presence drip) — both
 * proven against the deployed contracts. `ATTESTOR_PRIVATE_KEY` is read from `process.env` here
 * and nowhere else client-reachable; this file must never be imported from a "use client"
 * component or a route that could end up in the client bundle.
 */

import "server-only";

import { privateKeyToAccount } from "viem/accounts";
import { keccak256, toBytes, type Address, type Hex } from "viem";
import { getAvalRegistryAddressServer, getPresenceDripAddressServer } from "./chain";
import { WORLDCHAIN_ID } from "./worldchain";

export class AttestorConfigError extends Error {}

function getAttestorAccount() {
  const key = process.env.ATTESTOR_PRIVATE_KEY;
  if (!key) {
    throw new AttestorConfigError(
      "ATTESTOR_PRIVATE_KEY is not set. This server cannot sign enroll/vouch/claim attestations " +
        "without it — see app/.env.example.",
    );
  }
  try {
    return privateKeyToAccount(key as Hex);
  } catch {
    throw new AttestorConfigError("ATTESTOR_PRIVATE_KEY is not a valid private key.");
  }
}

/** Matches `MAX_ATTESTATION_TTL = 5 minutes` on both contracts (docs/10-constants.md §5) with a
 *  margin for clock skew and the time a human spends on a confirmation screen before broadcasting. */
export const ATTESTATION_TTL_SECONDS = 285;

export function deadlineFromNow(ttlSeconds: number = ATTESTATION_TTL_SECONDS): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + ttlSeconds);
}

export function randomNonce(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return BigInt(hex);
}

function avalRegistryDomain() {
  return {
    name: "AvalRegistry",
    version: "1",
    chainId: BigInt(WORLDCHAIN_ID),
    verifyingContract: getAvalRegistryAddressServer(),
  } as const;
}

function presenceDripDomain() {
  return {
    name: "PresenceDrip",
    version: "1",
    chainId: BigInt(WORLDCHAIN_ID),
    verifyingContract: getPresenceDripAddressServer(),
  } as const;
}

export interface EnrollAttestationInput {
  account: Address;
  nullifierHash: bigint;
  credential: Hex;
  deadline: bigint;
  nonce: bigint;
}

/** `EnrollAttestation(address account,uint256 nullifierHash,bytes32 credential,uint64 deadline,uint256 nonce)`
 *  — field order matches `AvalRegistry.sol`'s `ENROLL_TYPEHASH` exactly. */
export async function signEnrollAttestation(input: EnrollAttestationInput): Promise<Hex> {
  const attestor = getAttestorAccount();
  return attestor.signTypedData({
    domain: avalRegistryDomain(),
    types: {
      EnrollAttestation: [
        { name: "account", type: "address" },
        { name: "nullifierHash", type: "uint256" },
        { name: "credential", type: "bytes32" },
        { name: "deadline", type: "uint64" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "EnrollAttestation",
    message: input,
  });
}

export interface VouchAttestationInput {
  voucher: Address;
  vouchee: Address;
  voucherTier: number;
  deadline: bigint;
  nonce: bigint;
}

/** `VouchAttestation(address voucher,address vouchee,uint8 voucherTier,uint64 deadline,uint256 nonce)` */
export async function signVouchAttestation(input: VouchAttestationInput): Promise<Hex> {
  const attestor = getAttestorAccount();
  return attestor.signTypedData({
    domain: avalRegistryDomain(),
    types: {
      VouchAttestation: [
        { name: "voucher", type: "address" },
        { name: "vouchee", type: "address" },
        { name: "voucherTier", type: "uint8" },
        { name: "deadline", type: "uint64" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "VouchAttestation",
    message: input,
  });
}

export interface TierAttestationInput {
  account: Address;
  tier: number;
  deadline: bigint;
  nonce: bigint;
}

/** `TierAttestation(address account,uint8 tier,uint64 deadline,uint256 nonce)` — PresenceDrip.sol's
 *  own `TIER_TYPEHASH`, distinct domain (`name: "PresenceDrip"`) from the Aval registry's. */
export async function signTierAttestation(input: TierAttestationInput): Promise<Hex> {
  const attestor = getAttestorAccount();
  return attestor.signTypedData({
    domain: presenceDripDomain(),
    types: {
      TierAttestation: [
        { name: "account", type: "address" },
        { name: "tier", type: "uint8" },
        { name: "deadline", type: "uint64" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "TierAttestation",
    message: input,
  });
}

// Computed, not hand-copied — matches contracts/src/AvalRegistry.sol's inline comment
// `bytes32 credential, // keccak("selfie-check") | keccak("orb")` and scripts/live-scenario.mjs's
// own `CRED_SELFIE`/`CRED_ORB` derivation exactly (`keccak256(toBytes(...))`, same viem call).
export const CRED_SELFIE: Hex = keccak256(toBytes("selfie-check"));
export const CRED_ORB: Hex = keccak256(toBytes("orb"));
