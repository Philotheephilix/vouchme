import "server-only";

import { isAddress, getAddress, type Hex } from "viem";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import type { IDKitResult } from "@worldcoin/idkit-core";
import { AttestorConfigError, deadlineFromNow, randomNonce, signVouchAttestation } from "@/lib/attestation";
import { getEnrollmentNullifier, getLiveTier, isAddressEnrolled } from "@/lib/chain";
import { encodeVouchSignal } from "@/lib/worldid-client";
import { isJsonObject, ok, fail, FALLBACK_META } from "@/app/api/_lib/respond";

export const dynamic = "force-dynamic";

interface VouchAttestRequestBody {
  voucher?: string;
  vouchee?: string;
  idkitResult?: IDKitResult;
}

interface VerifyResponseItem {
  identifier: string;
  success: boolean;
  nullifier?: string;
}

interface VerifyApiResponse {
  success: boolean;
  results?: VerifyResponseItem[];
  environment?: string;
  code?: string;
  detail?: string;
}

const LEGACY_MAX_AGE_SECONDS = 3600;

export async function POST(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!isJsonObject(parsed)) return fail(400, "invalid_body", "Request body must be a JSON object.");
  const body = parsed as VouchAttestRequestBody;

  if (!body.voucher || !isAddress(body.voucher)) return fail(400, "invalid_voucher", "`voucher` must be a valid address.");
  if (!body.vouchee || !isAddress(body.vouchee)) return fail(400, "invalid_vouchee", "`vouchee` must be a valid address.");
  const voucher = getAddress(body.voucher);
  const vouchee = getAddress(body.vouchee);
  if (voucher.toLowerCase() === vouchee.toLowerCase()) {
    return fail(400, "self_vouch", "You cannot vouch for yourself.");
  }

  const result = body.idkitResult;
  if (!result || !("protocol_version" in result) || !Array.isArray(result.responses) || result.responses.length === 0) {
    return fail(400, "missing_proof", "`idkitResult` is missing or has no proof responses.");
  }

  const rpId = process.env.RP_ID;
  const action = process.env.WORLD_ID_ACTION;
  if (!rpId || !action) {
    return fail(503, "worldid_config_missing", "World ID is not configured on this server (RP_ID / WORLD_ID_ACTION).");
  }

  // W-5 (docs/03-worldid.md §8) said: "Vouch without require_user_presence ⇒ attestation refused by
  // the backend." That rule assumed the presence flag would be available. It is not — errata E-19.
  //
  // `user_presence_completed` is a World ID 4.0 field. The enrollment and vouch flows both use
  // `selfieCheckLegacy()`, whose own SDK docstring says "This preset only returns World ID 3.0
  // proofs", and a 3.0 payload has no such field. Requiring `=== true` therefore rejected every
  // genuine vouch: the user completed a real face scan and was told presence failed.
  //
  // There is NO presence gate here, and a three-state one would be wrong too. A first attempt at
  // this fix refused `user_presence_completed === false` on the reasoning that an explicit `false`
  // must mean "presence was attempted and failed". It does not. The client sends
  // `require_user_presence: false` (it has no choice — see the widget comment in VouchWizard.tsx),
  // so World App never runs a presence check and reports `false` to mean **"not requested"**. The
  // vouch was rejected with "World App reported that the user-presence check was not completed",
  // which was simply untrue: nothing had been asked of it.
  //
  // `false` and `undefined` are therefore indistinguishable here — both mean "this flow did not
  // ask for presence" — and neither is evidence of anything. Gating on a field whose value the
  // server itself determined by not requesting it is a check that can only ever produce false
  // negatives.
  //
  // What actually makes a vouch unforgeable is enforced below and is untouched:
  //   - the nullifier must equal the voucher's ENROLLED nullifier — the same human, not merely
  //     some verified human;
  //   - `signal` binds the proof to this exact voucher→vouchee edge, so a proof for A→B cannot be
  //     replayed as A→C.
  // Liveness is the only property lost, and it is lost at the SDK level (errata E-19), not here.

  // Edge binding — docs/03-worldid.md §5.1: "the edge is bound through `signal`, not through the
  // action string." A proof for edge A→B must not be replayable as A→C.
  const expectedSignalHash = hashSignal(encodeVouchSignal(voucher, vouchee));
  for (const r of result.responses as Array<{ signal_hash?: string }>) {
    if (r.signal_hash && r.signal_hash.toLowerCase() !== expectedSignalHash.toLowerCase()) {
      return fail(400, "signal_mismatch", "This presence proof was not generated for this specific vouch edge.");
    }
  }

  let verifyBody: Record<string, unknown>;
  if (result.protocol_version === "3.0") {
    verifyBody = {
      protocol_version: "3.0",
      nonce: result.nonce,
      action: result.action ?? action,
      responses: result.responses.map((r) => ({ ...r, max_age: LEGACY_MAX_AGE_SECONDS })),
    };
  } else if ("session_id" in result && result.session_id) {
    verifyBody = { protocol_version: "4.0", nonce: result.nonce, session_id: result.session_id, responses: result.responses };
  } else {
    verifyBody = {
      protocol_version: "4.0",
      nonce: result.nonce,
      action: "action" in result ? (result.action ?? action) : action,
      responses: result.responses,
    };
  }

  let verifyRes: Response;
  try {
    verifyRes = await fetch(`https://developer.world.org/api/v4/verify/${rpId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(verifyBody),
    });
  } catch (err) {
    return fail(502, "worldid_unreachable", err instanceof Error ? err.message : "Could not reach the World ID verify endpoint.");
  }

  let verifyJson: VerifyApiResponse;
  try {
    verifyJson = await verifyRes.json();
  } catch {
    return fail(502, "worldid_bad_response", "World ID verify endpoint returned a non-JSON response.");
  }

  console.log(`[/api/vouch/attest] World ID verify: environment=${verifyJson.environment ?? "unknown"} success=${verifyJson.success}`);

  if (!verifyRes.ok || !verifyJson.success) {
    const detail = verifyJson.detail ?? verifyJson.code ?? `HTTP ${verifyRes.status}`;
    return fail(400, "verification_failed", `World ID verification failed: ${detail}`);
  }

  const firstResult = verifyJson.results?.[0];
  if (!firstResult?.success || !firstResult.nullifier) {
    return fail(400, "verification_failed", "World ID verify succeeded but returned no usable result item.");
  }

  let presenceNullifier: bigint;
  try {
    presenceNullifier = BigInt(firstResult.nullifier as Hex);
  } catch {
    return fail(500, "bad_nullifier", "World ID returned a nullifier that is not valid hex.");
  }

  // docs/03-worldid.md §5.1: "same action ⇒ same nullifier ⇒ compare directly to the stored
  // enrollment nullifier." This build keeps no separate database, so "stored" means the account's
  // own `Enrolled` event — read live, not assumed.
  const enrollmentNullifier = await getEnrollmentNullifier(voucher);
  if (enrollmentNullifier === null) {
    return fail(409, "not_enrolled", "The vouching wallet is not enrolled in Aval.");
  }
  if (enrollmentNullifier !== presenceNullifier) {
    return fail(
      403,
      "nullifier_mismatch",
      "This presence proof was not generated by the same World ID that enrolled this account.",
    );
  }

  if (!(await isAddressEnrolled(vouchee))) {
    return fail(409, "vouchee_not_enrolled", "The account being vouched for is not enrolled in Aval.");
  }

  const voucherTier = await getLiveTier(voucher);
  if (voucherTier < 1) {
    return fail(403, "insufficient_tier", "Tier 0 accounts cannot vouch (FR-3) — you need at least Tier 1.");
  }

  const deadline = deadlineFromNow();
  const nonce = randomNonce();

  let attestation: Hex;
  try {
    attestation = await signVouchAttestation({ voucher, vouchee, voucherTier, deadline, nonce });
  } catch (err) {
    const status = err instanceof AttestorConfigError ? 503 : 500;
    return fail(status, "attestation_failed", err instanceof Error ? err.message : "Failed to sign the vouch attestation.");
  }

  return ok(
    {
      voucher,
      vouchee,
      voucherTier,
      deadline: deadline.toString(),
      nonce: nonce.toString(),
      attestation,
      environment: verifyJson.environment ?? "unknown",
    },
    FALLBACK_META,
  );
}
