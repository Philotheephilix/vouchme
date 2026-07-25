/**
 * app/src/lib/signInMessage.ts
 *
 * The exact text an injected wallet's `personal_sign` shows and signs, and the exact text the
 * server rebuilds to check that signature against (src/app/api/auth/verify/route.ts never trusts a
 * message the client sends — it reconstructs this itself from the address + the nonce it issued).
 * Pulled out of src/lib/authSession.ts (which is `server-only`, so a "use client" module like
 * src/lib/session.tsx cannot import it) since both sides need byte-for-byte the same string.
 * No secrets here — just formatting.
 */

import type { Address } from "@/lib/types";

export function buildSignInMessage(address: Address, nonce: string, issuedAt: number, expiresAt: number): string {
  const issuedIso = new Date(issuedAt * 1000).toISOString();
  const expiresIso = new Date(expiresAt * 1000).toISOString();
  return [
    "vouchme.davinciin.xyz wants you to sign in with your Ethereum account:",
    address,
    "",
    "Sign in to VouchMe.",
    "",
    `Nonce: ${nonce}`,
    `Issued At: ${issuedIso}`,
    `Expiration Time: ${expiresIso}`,
  ].join("\n");
}
