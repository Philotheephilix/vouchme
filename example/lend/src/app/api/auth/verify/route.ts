import { getAddress, isAddress } from "viem";
import {
  AuthConfigError,
  consumeNonce,
  messageBindsNonce,
  SESSION_COOKIE,
  signSession,
  verifyWalletSignature,
  type Address,
} from "@/lib/session";

export const dynamic = "force-dynamic";

interface VerifyBody {
  address?: string;
  message?: string;
  signature?: string;
  nonce?: { nonce?: string };
}

/**
 * Turns a `MiniKit.walletAuth()` payload into a session.
 *
 * Order matters and is not an accident:
 *   1. burn the nonce  — so a failed attempt cannot be retried against the same challenge
 *   2. check the message carries that nonce — binds the signature to THIS attempt
 *   3. check the signature — the expensive step, and the one that needs an RPC
 * Only then is a session minted.
 */
export async function POST(req: Request): Promise<Response> {
  let body: VerifyBody;
  try {
    body = (await req.json()) as VerifyBody;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }

  const { address, message, signature, nonce } = body;
  if (!address || !isAddress(address)) {
    return Response.json({ error: "A valid `address` is required." }, { status: 400 });
  }
  if (typeof message !== "string" || !message) {
    return Response.json(
      { error: "`message` is required — send the exact bytes the wallet signed." },
      { status: 400 },
    );
  }
  if (typeof signature !== "string" || !signature.startsWith("0x")) {
    return Response.json({ error: "`signature` is required." }, { status: 400 });
  }

  let consumed;
  try {
    consumed = consumeNonce(nonce);
  } catch (err) {
    if (err instanceof AuthConfigError) return Response.json({ error: err.message }, { status: 503 });
    throw err;
  }
  if (!consumed.ok) return Response.json({ error: consumed.reason }, { status: 401 });

  if (!messageBindsNonce(message, nonce?.nonce ?? "")) {
    return Response.json(
      { error: "The signed message does not contain the challenge this server issued." },
      { status: 401 },
    );
  }

  const checksummed = getAddress(address) as Address;
  if (!(await verifyWalletSignature(checksummed, message, signature as `0x${string}`))) {
    return Response.json(
      { error: "That signature does not verify for that address on this chain." },
      { status: 401 },
    );
  }

  const session = signSession(checksummed);
  const res = Response.json({ address: checksummed });
  res.headers.append(
    "set-cookie",
    [
      `${SESSION_COOKIE}=${session.value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${session.maxAge}`,
      // World App serves mini apps over HTTPS; local development over plain http would drop a
      // Secure cookie entirely, so this follows the request rather than being hardcoded either way.
      new URL(req.url).protocol === "https:" ? "Secure" : "",
    ]
      .filter(Boolean)
      .join("; "),
  );
  return res;
}
