import { isAddress, isHex, getAddress } from "viem";
import {
  AuthConfigError,
  buildSignInMessage,
  consumeNonce,
  setSessionCookies,
  verifyWalletSignature,
} from "@/lib/authSession";
import type { Address } from "@/lib/types";
import { fail, isJsonObject, ok } from "@/app/api/_lib/respond";
import { FALLBACK_META } from "@/app/api/_lib/respond";

export const dynamic = "force-dynamic";

interface VerifyRequestBody {
  address?: string;
  signature?: string;
  nonce?: unknown;
  /**
   * Present only for the MiniKit (World App) path, whose `walletAuth` produces its own SIWE text
   * via `MiniKit.walletAuth` rather than the message this server would build itself — so unlike
   * the injected-wallet path, the message can't be silently reconstructed server-side and must be
   * supplied. Still bound to a server-issued, single-use nonce (checked below) and still run
   * through the same signature check, so this isn't a second trust path — MiniKit already performs
   * a real on-device signature via World App, and this is what turns that into a verified session.
   */
  message?: string;
}

function isSecureRequest(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0]!.trim() === "https";
  return new URL(req.url).protocol === "https:";
}

/**
 * Step 2 — and the only place a session is ever minted. Verifies a real EIP-191 `personal_sign`
 * signature over the exact message this server would have built for the claimed address + a nonce
 * this server issued, single-use and unexpired. Only on success does it set `aval_session` — every
 * other path returns 401 and touches no cookie at all.
 *
 * The message itself is never taken from the client (only `address`, `signature` and the opaque
 * `nonce` token are) — it's rebuilt server-side from `buildSignInMessage`, so nothing the client
 * sends can widen what gets signed.
 */
export async function POST(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!isJsonObject(parsed)) return fail(400, "invalid_body", "Request body must be a JSON object.");
  const body = parsed as VerifyRequestBody;

  if (!body.address || !isAddress(body.address)) return fail(400, "invalid_address", "`address` must be a valid address.");
  if (!body.signature || !isHex(body.signature)) return fail(400, "invalid_signature", "`signature` must be a hex string.");

  const address = getAddress(body.address) as Address;

  // Everything below depends on ATTESTOR_PRIVATE_KEY (consumeNonce's HMAC check, and — on success
  // — signing the session cookie): one try/catch around all of it, same "not configured -> 503,
  // never fall back to trusting the request anyway" shape as /api/enroll/rp-context.
  try {
    const consumed = consumeNonce(body.nonce);
    if (!consumed.ok) return fail(401, "invalid_nonce", consumed.reason);

    let messageToVerify: string;
    if (body.message !== undefined) {
      // MiniKit path — the message is World App's own SIWE text, not ours. Require it to
      // reference the exact nonce we just consumed, so a signature over some unrelated message
      // can never be replayed here.
      if (typeof body.message !== "string" || !body.message.includes(`Nonce: ${consumed.nonce.nonce}`)) {
        return fail(401, "nonce_mismatch", "Signed message does not reference the issued nonce.");
      }
      messageToVerify = body.message;
    } else {
      // Injected-wallet path — the message is never taken from the client at all; it's rebuilt
      // here from the address and the nonce we issued, so nothing the client sends can widen what
      // was actually signed.
      messageToVerify = buildSignInMessage(address, consumed.nonce);
    }

    const verified = await verifyWalletSignature(address, messageToVerify, body.signature);
    if (!verified) {
      return fail(401, "signature_invalid", "Could not verify this signature was produced by that address.");
    }

    const response = ok({ address }, FALLBACK_META);
    setSessionCookies(response.cookies, address, isSecureRequest(req));
    return response;
  } catch (err) {
    if (err instanceof AuthConfigError) return fail(503, "auth_config_missing", err.message, FALLBACK_META);
    return fail(500, "verify_failed", err instanceof Error ? err.message : "Sign-in verification failed.", FALLBACK_META);
  }
}
