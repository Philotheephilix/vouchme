/**
 * app/src/lib/authClient.ts
 *
 * Client-side helpers for the sign-in-with-a-real-signature flow (docs/96-ux-audit.md U-24),
 * called from src/lib/session.tsx. Mirrors src/lib/worldid-client.ts's `fetchRpContext` shape on
 * purpose — same "fetch a server-signed token, then redeem it" pattern as
 * `/api/enroll/rp-context`, just for `/api/auth/nonce` + `/api/auth/verify` instead.
 */

export interface NonceToken {
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  sig: string;
}

export async function fetchNonce(): Promise<NonceToken> {
  const res = await fetch("/api/auth/nonce");
  const body = await res.json();
  if (!res.ok || body?.error) {
    throw new Error(body?.error?.message ?? "Failed to prepare a sign-in request.");
  }
  return body.data as NonceToken;
}

export interface VerifySignInInput {
  address: string;
  signature: string;
  nonce: NonceToken;
  /** MiniKit path only — its own SIWE message text. Omit for the injected-wallet path, where the
   *  server rebuilds the expected message itself. */
  message?: string;
}

/** Redeems a signature at `/api/auth/verify`. On success the server has already set the verified,
 *  httpOnly `aval_session` cookie (and the plain `aval_addr` mirror) via `Set-Cookie` — nothing
 *  more for the caller to persist. Throws with a human-readable message on any failure. */
export async function verifySignIn(input: VerifySignInInput): Promise<{ address: string }> {
  const res = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await res.json();
  if (!res.ok || body?.error) {
    throw new Error(body?.error?.message ?? "Could not verify this wallet's signature.");
  }
  return body.data as { address: string };
}

export async function signOutSession(): Promise<void> {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {
    // Best-effort — the client-side state clear in disconnect() is what actually matters for UX;
    // a failed logout call just leaves a still-valid (but now unreferenced) session cookie until
    // it expires or the next call succeeds.
  }
}

/**
 * Ask the SERVER who is signed in, from the httpOnly `aval_session` cookie the client cannot read.
 *
 * Returns null when there is no verified session — including on any network or parse error, so a
 * failed check can never be mistaken for a valid session.
 */
export async function fetchVerifiedSession(): Promise<`0x${string}` | null> {
  try {
    const res = await fetch("/api/auth/session", { cache: "no-store" });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    const data = (body as { data?: { address?: string | null; verified?: boolean } }).data;
    if (!data?.verified || !data.address) return null;
    return data.address as `0x${string}`;
  } catch {
    return null;
  }
}
