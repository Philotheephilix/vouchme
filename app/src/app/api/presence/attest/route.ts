import "server-only";

import { isAddress, getAddress, type Hex } from "viem";
import { AttestorConfigError, deadlineFromNow, randomNonce, signTierAttestation } from "@/lib/attestation";
import { isAddressEnrolled, getLiveTier } from "@/lib/chain";
import { isJsonObject, ok, fail, FALLBACK_META } from "@/app/api/_lib/respond";

export const dynamic = "force-dynamic";

interface PresenceAttestBody {
  address?: string;
}

/**
 * Signs the `TierAttestation` `PresenceDrip.claim(tier, deadline, nonce, attestation)` needs.
 * Tier determines the payout rate (25% at Tier 0, 100% at Tier 1/2 — docs/16-presence-drip.md §3),
 * a whole-graph fact the EVM can't compute, same pattern as `VouchMeRegistry.vouch`'s `voucherTier`.
 * No World ID proof required here (docs/10-constants.md §12: "Claiming requires presence check:
 * no — claiming creates no trust, only vouching does") — this just attests the caller's own,
 * already-public, live-computed tier.
 */
export async function POST(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!isJsonObject(parsed)) return fail(400, "invalid_body", "Request body must be a JSON object.");
  const body = parsed as PresenceAttestBody;

  if (!body.address || !isAddress(body.address)) return fail(400, "invalid_address", "`address` must be a valid address.");
  const address = getAddress(body.address);

  if (!(await isAddressEnrolled(address))) {
    return fail(409, "not_enrolled", "This wallet is not enrolled in VouchMe.");
  }

  const tier = await getLiveTier(address);
  const deadline = deadlineFromNow();
  const nonce = randomNonce();

  let attestation: Hex;
  try {
    attestation = await signTierAttestation({ account: address, tier, deadline, nonce });
  } catch (err) {
    const status = err instanceof AttestorConfigError ? 503 : 500;
    return fail(status, "attestation_failed", err instanceof Error ? err.message : "Failed to sign the tier attestation.");
  }

  return ok({ address, tier, deadline: deadline.toString(), nonce: nonce.toString(), attestation }, FALLBACK_META);
}
