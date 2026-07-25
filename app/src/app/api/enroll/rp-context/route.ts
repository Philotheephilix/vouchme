import "server-only";

import { signRequest } from "@worldcoin/idkit-core/signing";
import { fail, ok } from "@/app/api/_lib/respond";
import { FALLBACK_META } from "@/app/api/_lib/respond";

// Never cache — a fresh nonce + timestamp per request, always.
export const dynamic = "force-dynamic";

/**
 * Signs a fresh `rp_context` for `@worldcoin/idkit`'s `IDKit.request()` — every request config in
 * idkit@4.x requires one (`IDKitRequestConfig.rp_context`), generated server-side from
 * `ATTESTOR_PRIVATE_KEY` (the only signing key this deployment provisions; see
 * `src/lib/attestation.ts`'s doc comment). `signRequest` is the pure-JS subpath export
 * (`@worldcoin/idkit-core/signing`) — no WASM init, safe in a Next.js route handler.
 */
export async function GET(): Promise<Response> {
  const rpId = process.env.RP_ID;
  const action = process.env.WORLD_ID_ACTION;
  const key = process.env.ATTESTOR_PRIVATE_KEY;
  if (!rpId || !action || !key) {
    return fail(
      503,
      "worldid_config_missing",
      "World ID is not configured on this server (RP_ID / WORLD_ID_ACTION / ATTESTOR_PRIVATE_KEY).",
      FALLBACK_META,
    );
  }

  let sig;
  try {
    sig = signRequest({ signingKeyHex: key, action, ttl: 300 });
  } catch (err) {
    return fail(
      500,
      "rp_context_sign_failed",
      err instanceof Error ? err.message : "Failed to sign the World ID request context.",
      FALLBACK_META,
    );
  }

  return ok(
    {
      rp_id: rpId,
      nonce: sig.nonce,
      created_at: sig.createdAt,
      expires_at: sig.expiresAt,
      signature: sig.sig,
    },
    FALLBACK_META,
  );
}
