import { cookies } from "next/headers";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import type { IDKitResult } from "@worldcoin/idkit-core";
import { ATTESTATION_TTL_MS, getAttestation, isStubbedVerifier, IdentityConfigError, saveAttestation, takeChallenge, verifyEndpoint, worldIdConfig } from "@/lib/identityStore";
import { attestationSatisfies, type IdentityAttestation } from "@/lib/identity";
import { POOLS } from "@/lib/pools";
import { readVerifiedAddress } from "@/lib/session";

export const dynamic = "force-dynamic";

/** What World's verify endpoint answers with. `identity_attested` is declared here as OPTIONAL
 *  because that is what it is — see the long comment at step 6. */
interface VerifyApiResponse {
  success?: boolean;
  results?: Array<{ identifier?: string; success?: boolean; nullifier?: string; code?: string; detail?: string }>;
  environment?: string;
  code?: string;
  detail?: string;
  message?: string;
  identity_attested?: boolean;
}

/** GET — what does the server believe about this session's identity, and what does that unlock.
 *  Read-only, and derived entirely from the server's own stored conclusion. */
export async function GET(): Promise<Response> {
  const address = readVerifiedAddress(await cookies());
  if (!address) {
    return Response.json({ code: "not_signed_in", error: "Sign in with World first." }, { status: 401 });
  }
  const attestation = getAttestation(address);
  return Response.json(
    {
      attested: Boolean(attestation),
      minimumAge: attestation?.minimumAge ?? null,
      issuingCountry: attestation?.issuingCountry ?? null,
      expiresAt: attestation?.expiresAt ?? null,
      environment: attestation?.environment ?? null,
      pools: Object.fromEntries(POOLS.map((p) => [p.id, attestationSatisfies(p.identity, attestation)])),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

/**
 * POST — turn a client's IDKit result into Lend's own conclusion, or refuse.
 *
 * ── The one rule ────────────────────────────────────────────────────────────────────────────────
 *
 * NOTHING in the request body is evidence. The body carries an `IDKitResultV4`, and that object has
 * an `identity_attested` field sitting right there, already `true`, looking exactly like the answer.
 * It is not. It is a JSON field a caller typed. The only `identity_attested` this route will read is
 * the one on WORLD'S reply to OUR request, made from this server under our own rp_id.
 *
 * ── The order, and why ──────────────────────────────────────────────────────────────────────────
 *
 *   1. session        — who is asking, provably
 *   2. shape          — is this even a v4 result
 *   3. challenge      — did WE start this, for THIS address, and burn it either way
 *   4. signal         — if a signal hash came back, does it match the one we bound
 *   5. verify         — ask World, under our key
 *   6. attested       — World's answer, treated as no unless it is explicitly yes
 *   7. nullifier      — one document, one account
 *   8. persist        — store what we concluded, not what we were told
 */
export async function POST(req: Request): Promise<Response> {
  // 1. Who is asking.
  const address = readVerifiedAddress(await cookies());
  if (!address) {
    return Response.json({ code: "not_signed_in", error: "Sign in with World first." }, { status: 401 });
  }

  let body: { idkitResult?: IDKitResult };
  try {
    body = (await req.json()) as { idkitResult?: IDKitResult };
  } catch {
    return Response.json({ code: "bad_request", error: "Request body must be valid JSON." }, { status: 400 });
  }

  // 2. Shape. Identity Check is a World ID 4.0 feature; a 3.0 result cannot carry an attestation, so
  //    accepting one would be accepting a proof of something else entirely.
  const result = body?.idkitResult;
  if (!result || typeof result !== "object" || !("protocol_version" in result)) {
    return Response.json({ code: "missing_proof", error: "`idkitResult` is missing." }, { status: 400 });
  }
  if (result.protocol_version !== "4.0" || "session_id" in result) {
    return Response.json(
      {
        code: "wrong_protocol",
        error: "Identity Check requires a World ID 4.0 uniqueness proof. This is not one.",
      },
      { status: 400 },
    );
  }
  if (!Array.isArray(result.responses) || result.responses.length === 0) {
    return Response.json({ code: "missing_proof", error: "This proof has no responses." }, { status: 400 });
  }

  // 3. Did we start this? Burns the challenge whatever happens next.
  const taken = takeChallenge(result.nonce, address);
  if (!taken.ok) {
    return Response.json({ code: "unknown_challenge", error: taken.reason }, { status: 400 });
  }
  const { challenge } = taken;

  // 4. Signal binding, when the response carries one.
  //
  //    `legacy_signal` turns out not to be legacy-only: it reaches the v4 credential requests too
  //    (`npm run test:probe`, §D3), so a `signal_hash` should come back on the response items.
  //
  //    Corroborating only, never THE binding. A response that simply omits `signal_hash` would
  //    otherwise bind to nothing and pass vacuously — for exactly the caller who stripped it. Step 3
  //    is the binding that always holds.
  //
  //    UNVERIFIED, and flagged as such because it cannot be tested without entitlement: the probe
  //    shows idkit puts `hashSignal(s)` in the LEGACY top-level signal but the hex of the raw UTF-8
  //    bytes in `proof_requests[].signal`, and which convention `signal_hash` comes back in is not
  //    documented. If a genuine attestation ever lands here as `signal_mismatch`, this is the line
  //    to revisit — the log below prints both values so it is a one-minute diagnosis, and the
  //    failure direction is refusal, which is the safe one.
  const expectedSignalHash = hashSignal(challenge.signal).toLowerCase();
  for (const r of result.responses as Array<{ signal_hash?: string }>) {
    if (r.signal_hash && r.signal_hash.toLowerCase() !== expectedSignalHash) {
      console.warn(
        `[/api/identity] signal mismatch: response=${r.signal_hash} expected=${expectedSignalHash} ` +
          `signal=${JSON.stringify(challenge.signal)}`,
      );
      return Response.json(
        {
          code: "signal_mismatch",
          error: "This proof was generated for a different verification request.",
        },
        { status: 400 },
      );
    }
  }

  let config;
  try {
    config = worldIdConfig();
  } catch (err) {
    if (err instanceof IdentityConfigError) {
      return Response.json({ code: "identity_unavailable", error: err.message }, { status: 503 });
    }
    throw err;
  }

  // 5. Ask World. Under OUR rp_id, from OUR server. Same shape as `app/src/app/api/enroll/route.ts`.
  let verifyRes: Response;
  try {
    verifyRes = await fetch(verifyEndpoint(config.rpId), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol_version: "4.0",
        nonce: result.nonce,
        action: result.action ?? config.action,
        responses: result.responses,
      }),
    });
  } catch (err) {
    return Response.json(
      {
        code: "worldid_unreachable",
        error: err instanceof Error ? err.message : "Could not reach the World ID verify endpoint.",
      },
      { status: 502 },
    );
  }

  let verify: VerifyApiResponse;
  try {
    verify = (await verifyRes.json()) as VerifyApiResponse;
  } catch {
    return Response.json(
      { code: "worldid_bad_response", error: "World ID returned a non-JSON response." },
      { status: 502 },
    );
  }

  console.log(
    `[/api/identity] verify: http=${verifyRes.status} success=${verify.success} ` +
      `environment=${verify.environment ?? "unknown"} identity_attested=${String(verify.identity_attested)}`,
  );

  if (!verifyRes.ok || verify.success !== true) {
    const detail = verify.detail ?? verify.message ?? verify.code ?? `HTTP ${verifyRes.status}`;
    return Response.json(
      { code: "verification_failed", error: `World ID could not verify that proof: ${detail}` },
      { status: 400 },
    );
  }

  const first = verify.results?.[0];
  if (!first?.success || !first.nullifier) {
    return Response.json(
      { code: "verification_failed", error: "World ID verified the request but returned no usable result." },
      { status: 400 },
    );
  }

  // 6. ── The check this whole file exists for ────────────────────────────────────────────────────
  //
  // `identity_attested` is `boolean | undefined`. TypeScript will happily compile
  //
  //     if (verify.identity_attested !== false) { unlock() }
  //
  // and that is a hole you could drive a truck through: `undefined !== false` is true, so an
  // endpoint that never mentions attestation at all — because the field was dropped, because the
  // app id lacks the preview entitlement, because a proxy stripped it — reads as a pass. The
  // optional type is exactly what makes it compile.
  //
  // So the test is `=== true` and nothing else. Absent is not attested. False is not attested.
  // Only the literal boolean true, from World's own reply, opens a pool.
  //
  // TODAY THIS ALWAYS REFUSES against the real endpoint, and that is the correct behaviour rather
  // than a bug to be worked around: the published v4 verify response schema does not include
  // `identity_attested` (see IDENTITY-CHECK-TESTING.md §D1), so until World's entitlement lands and
  // the field appears, Lend cannot confirm an attestation and therefore does not grant one.
  if (verify.identity_attested !== true) {
    return Response.json(
      {
        code: "not_attested",
        error:
          verify.identity_attested === false
            ? "Your ID did not match what this pool requires."
            : "World ID verified your proof but did not return an identity attestation. Lend cannot " +
              "open this pool without one. Identity Check is in preview and may not be enabled for " +
              "this app yet.",
        // Told apart deliberately: a mismatch is about the person, an absence is about us.
        reason: verify.identity_attested === false ? "attributes_not_matched" : "attestation_absent",
      },
      { status: 403 },
    );
  }

  // 7 & 8. Store OUR conclusion — derived from the policy WE recorded on the challenge, never from
  //        an attribute list the client echoed back at us.
  const attestation: IdentityAttestation = {
    address: address.toLowerCase(),
    minimumAge: challenge.policy.minimumAge,
    issuingCountry: challenge.policy.jurisdiction === "served" ? challenge.declaredCountry : null,
    nullifier: first.nullifier.toLowerCase(),
    attestedAt: Date.now(),
    expiresAt: Date.now() + ATTESTATION_TTL_MS,
    environment: verify.environment ?? "unknown",
  };

  const saved = saveAttestation(attestation);
  if (!saved.ok) {
    return Response.json({ code: "nullifier_reused", error: saved.reason }, { status: 409 });
  }

  return Response.json({
    attested: true,
    minimumAge: attestation.minimumAge,
    issuingCountry: attestation.issuingCountry,
    expiresAt: attestation.expiresAt,
    environment: attestation.environment,
    // Loud on purpose. A green tick produced by a local stub must never be mistakable for one
    // produced by World.
    stubbedVerifier: isStubbedVerifier(),
    pools: Object.fromEntries(POOLS.map((p) => [p.id, attestationSatisfies(p.identity, attestation)])),
  });
}
