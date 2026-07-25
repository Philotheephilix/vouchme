import { AuthConfigError, issueNonce } from "@/lib/authSession";
import { fail, ok } from "@/app/api/_lib/respond";
import { FALLBACK_META } from "@/app/api/_lib/respond";

// A fresh, single-use, expiring nonce per request — never cache.
export const dynamic = "force-dynamic";

/**
 * Step 1 of the sign-in-with-a-real-signature flow: issue a nonce the client will embed in the
 * message it signs with the injected wallet's `personal_sign`, and post back verbatim to
 * `/api/auth/verify`. Same shape as `/api/enroll/rp-context` (nonce + issuedAt + expiresAt signed
 * server-side with ATTESTOR_PRIVATE_KEY) — see src/lib/authSession.ts's doc comment for why this
 * deployment reuses that key rather than provisioning a second secret.
 */
export async function GET(): Promise<Response> {
  try {
    return ok(issueNonce(), FALLBACK_META);
  } catch (err) {
    if (err instanceof AuthConfigError) {
      return fail(503, "auth_config_missing", err.message, FALLBACK_META);
    }
    return fail(500, "nonce_failed", err instanceof Error ? err.message : "Failed to issue a sign-in nonce.", FALLBACK_META);
  }
}
