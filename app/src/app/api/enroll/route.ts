import "server-only";

import { isAddress, getAddress, type Hex } from "viem";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import type { IDKitResult } from "@worldcoin/idkit-core";
import { AttestorConfigError, CRED_SELFIE, deadlineFromNow, randomNonce, signEnrollAttestation } from "@/lib/attestation";
import { findAccountByNullifier, isAddressEnrolled, isNullifierUsed } from "@/lib/chain";
import { isJsonObject, ok, fail, FALLBACK_META } from "@/app/api/_lib/respond";

export const dynamic = "force-dynamic";

const HANDLE_RE = /^[a-z0-9-]{3,20}$/;

interface EnrollRequestBody {
  address?: string;
  handle?: string;
  idkitResult?: IDKitResult;
}

interface VerifyResponseItem {
  identifier: string;
  success: boolean;
  nullifier?: string; // hex
}

interface VerifyApiResponse {
  success: boolean;
  results?: VerifyResponseItem[];
  action?: string;
  created_at?: string;
  environment?: string;
  code?: string;
  detail?: string;
  attribute?: string;
}

/** `max_age` window (seconds) requested on legacy (3.0) responses — the *proof's* own freshness
 *  tolerance, not the credential's validity. Our flow submits immediately after generation, so any
 *  value in the documented 3600-604800s range works; the low end is used deliberately (tightest
 *  replay window we can ask for). */
const LEGACY_MAX_AGE_SECONDS = 3600;

export async function POST(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!isJsonObject(parsed)) return fail(400, "invalid_body", "Request body must be a JSON object.");
  const body = parsed as EnrollRequestBody;

  if (!body.address || !isAddress(body.address)) {
    return fail(400, "invalid_address", "`address` must be a valid wallet address.");
  }
  const address = getAddress(body.address);

  if (!body.handle || !HANDLE_RE.test(body.handle)) {
    return fail(400, "invalid_handle", "`handle` must be 3-20 lowercase a-z/0-9/hyphen characters.");
  }
  const handle = `${body.handle}.aval.eth`;

  const result = body.idkitResult;
  if (!result || !("protocol_version" in result) || !Array.isArray(result.responses) || result.responses.length === 0) {
    return fail(400, "missing_proof", "`idkitResult` is missing or has no proof responses.");
  }

  const appId = process.env.NEXT_PUBLIC_APP_ID;
  const rpId = process.env.RP_ID;
  const action = process.env.WORLD_ID_ACTION;
  if (!appId || !rpId || !action) {
    return fail(503, "worldid_config_missing", "World ID is not configured on this server (NEXT_PUBLIC_APP_ID / RP_ID / WORLD_ID_ACTION).");
  }

  // ── signal binding: `signal = walletAddress` "means a proof produced for wallet A cannot be
  // replayed to enroll wallet B" (docs/03-worldid.md §2.1) — that guarantee only holds if WE check
  // it. World's verify endpoint confirms the proof is internally consistent; it never learns which
  // address we intend to enroll, so nothing there stops a caller from generating a proof for
  // address A and then POSTing here claiming `address: B`. `hashSignal` is the same pure-JS
  // primitive `@worldcoin/idkit` uses client-side to embed the signal, so recomputing it here and
  // comparing is an exact check, not a heuristic. ─────────────────────────────────────────────────
  const expectedSignalHash = hashSignal(address);
  for (const r of result.responses as Array<{ signal_hash?: string }>) {
    if (r.signal_hash && r.signal_hash.toLowerCase() !== expectedSignalHash.toLowerCase()) {
      return fail(
        400,
        "signal_mismatch",
        "This World ID proof was not generated for the connecting wallet address. Generate a new proof with this wallet selected.",
      );
    }
  }

  // ── build the verify-endpoint body for whichever of the three proof shapes IDKit produced
  // (docs task Q4: empirically, `selfieCheckLegacy()` — the only preset IDKit's own SDK exposes
  // for this credential — is typed "This preset only returns World ID 3.0 proofs," so the 3.0
  // branch is the one this flow actually exercises; the other two are handled for completeness
  // against the verify endpoint's documented `oneOf`). ───────────────────────────────────────────
  let verifyBody: Record<string, unknown>;
  if (result.protocol_version === "3.0") {
    verifyBody = {
      protocol_version: "3.0",
      nonce: result.nonce,
      action: result.action ?? action,
      responses: result.responses.map((r) => ({ ...r, max_age: LEGACY_MAX_AGE_SECONDS })),
    };
  } else if ("session_id" in result && result.session_id) {
    verifyBody = {
      protocol_version: "4.0",
      nonce: result.nonce,
      session_id: result.session_id,
      responses: result.responses,
    };
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

  // Staging vs production matters for a real deployment — surfaced, not swallowed.
  console.log(`[/api/enroll] World ID verify: environment=${verifyJson.environment ?? "unknown"} success=${verifyJson.success}`);

  if (!verifyRes.ok || !verifyJson.success) {
    const detail = verifyJson.detail ?? verifyJson.code ?? `HTTP ${verifyRes.status}`;
    return fail(400, "verification_failed", `World ID verification failed: ${detail}`);
  }

  // The nullifier lives inside `results[]`, never at the top level — reading the wrong field makes
  // uniqueness silently do nothing.
  const firstResult = verifyJson.results?.[0];
  if (!firstResult?.success || !firstResult.nullifier) {
    return fail(400, "verification_failed", "World ID verify succeeded but returned no usable result item.");
  }

  // Decimal string end-to-end, never a JS `number` (docs/03-worldid.md §2.3) — above 2^53 a Number
  // silently truncates and collides.
  let nullifierHash: bigint;
  try {
    nullifierHash = BigInt(firstResult.nullifier as Hex);
  } catch {
    return fail(500, "bad_nullifier", "World ID returned a nullifier that is not valid hex.");
  }

  if (await isAddressEnrolled(address)) {
    return fail(409, "already_enrolled", "This wallet is already enrolled in Aval.");
  }

  if (await isNullifierUsed(nullifierHash)) {
    const existing = await findAccountByNullifier(nullifierHash);
    return fail(
      409,
      "nullifier_used",
      existing && existing.toLowerCase() !== address.toLowerCase()
        ? "This World ID is already registered to an Aval account. If that account is yours, sign in with it. If it isn't, this device's verification has been used elsewhere."
        : "This World ID has already been used to enroll.",
    );
  }

  const deadline = deadlineFromNow();
  const nonce = randomNonce();

  let attestation: Hex;
  try {
    attestation = await signEnrollAttestation({ account: address, nullifierHash, credential: CRED_SELFIE, deadline, nonce });
  } catch (err) {
    const status = err instanceof AttestorConfigError ? 503 : 500;
    return fail(status, "attestation_failed", err instanceof Error ? err.message : "Failed to sign the enroll attestation.");
  }

  return ok(
    {
      address,
      handle,
      credential: CRED_SELFIE,
      nullifierHash: nullifierHash.toString(),
      deadline: deadline.toString(),
      nonce: nonce.toString(),
      attestation,
      environment: verifyJson.environment ?? "unknown",
    },
    FALLBACK_META,
  );
}
