import { cookies } from "next/headers";
import { randomBytes } from "crypto";
import { signRequest } from "@worldcoin/idkit-core/signing";
import {
  attributesFor,
  IdentityPolicyError,
  isServedJurisdiction,
  SERVED_JURISDICTIONS,
  consentCopy,
} from "@/lib/identity";
import { IdentityConfigError, putChallenge, worldIdConfig } from "@/lib/identityStore";
import { findPool } from "@/lib/pools";
import { readVerifiedAddress } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Step one of the identity gate: decide what we are allowed to ask, and mint a request bound to the
 * asker.
 *
 * The client cannot do any of this itself, and that is the point:
 *
 *  - `rp_context` is an ECDSA signature over a nonce and a timestamp window, made with a key that
 *    only this server holds. `signRequest` is the pure-JS subpath export, so no WASM is initialised
 *    in a route handler. Mirrors `app/src/app/api/enroll/rp-context/route.ts`.
 *  - The ATTRIBUTES are chosen here, from the pool's policy, and returned to the client to be put on
 *    the wire. A client that edits them only changes what it asks World about; the server checks the
 *    answer against the policy it recorded, not against what the client says it asked.
 *  - The jurisdiction is refused HERE, before World is contacted at all. Somebody outside the
 *    licensed territory is told no without opening their document. That is the whole moral argument
 *    for attestations over document upload, and it would be lost if the check happened after.
 */
export async function POST(req: Request): Promise<Response> {
  const address = readVerifiedAddress(await cookies());
  if (!address) {
    return Response.json({ code: "not_signed_in", error: "Sign in with World first." }, { status: 401 });
  }

  let body: { pool?: unknown; country?: unknown };
  try {
    body = (await req.json()) as { pool?: unknown; country?: unknown };
  } catch {
    return Response.json({ code: "bad_request", error: "Request body must be valid JSON." }, { status: 400 });
  }

  const pool = findPool(body?.pool);
  if (!pool) {
    return Response.json({ code: "unknown_pool", error: "No such pool." }, { status: 404 });
  }

  const declaredCountry =
    typeof body.country === "string" && body.country ? body.country.toUpperCase() : null;

  // Refused before any attributes are built, so the message can name the list rather than say
  // "policy error". A person who picked an unserved country deserves to know which are served.
  if (pool.identity.jurisdiction === "served" && !isServedJurisdiction(declaredCountry)) {
    return Response.json(
      {
        code: "jurisdiction_unavailable",
        error:
          declaredCountry === null
            ? `${pool.name} is only offered in some countries. Tell us where your ID was issued.`
            : `Lend is not licensed to offer ${pool.name} in ${declaredCountry}.`,
        served: SERVED_JURISDICTIONS,
      },
      { status: 403 },
    );
  }

  let config;
  try {
    config = worldIdConfig();
  } catch (err) {
    if (err instanceof IdentityConfigError) {
      // Fail closed and SAY WHY. An identity gate that cannot be run must leave the pool shut, and
      // must not leave the user guessing whether they failed a check or the server is broken.
      return Response.json({ code: "identity_unavailable", error: err.message }, { status: 503 });
    }
    throw err;
  }

  let attributes;
  try {
    attributes = attributesFor(pool.identity, declaredCountry);
  } catch (err) {
    if (err instanceof IdentityPolicyError) {
      return Response.json({ code: "jurisdiction_unavailable", error: err.message }, { status: 403 });
    }
    throw err;
  }

  let signed;
  try {
    signed = signRequest({ signingKeyHex: config.signingKey, action: config.action, ttl: 300 });
  } catch (err) {
    return Response.json(
      {
        code: "rp_context_sign_failed",
        error: err instanceof Error ? err.message : "Could not sign the World ID request context.",
      },
      { status: 500 },
    );
  }

  // Bound to the session address and to this one attempt. `legacy_signal` is the only signal knob
  // `identityCheck()` exposes; we use it, and we also record it so the response's `signal_hash` can
  // be checked against it server-side.
  const signal = `lend-identity:${address.toLowerCase()}:${randomBytes(8).toString("hex")}`;

  putChallenge({
    nonce: signed.nonce,
    address: address.toLowerCase(),
    policy: pool.identity,
    declaredCountry,
    signal,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

  return Response.json(
    {
      app_id: config.appId,
      action: config.action,
      rp_context: {
        rp_id: config.rpId,
        nonce: signed.nonce,
        created_at: signed.createdAt,
        expires_at: signed.expiresAt,
        signature: signed.sig,
      },
      attributes,
      signal,
      consent: consentCopy(pool.identity, declaredCountry),
    },
    { headers: { "cache-control": "no-store" } },
  );
}
