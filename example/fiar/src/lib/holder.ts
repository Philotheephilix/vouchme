import "server-only";

import { cookies } from "next/headers";
import { AuthConfigError, readVerifiedAddress } from "./session";

export interface Holder {
  id: string | null;
  /** True only when this came from an HMAC-bound session cookie minted after a verified wallet
   *  signature. Everything else is a preview, and the UI must say so — a screen that looks
   *  identical whether or not you proved anything teaches people the proof is decorative. */
  verified: boolean;
}

/**
 * Who this page is about.
 *
 * A verified session always wins. `?as=` is a preview affordance for running Fiar in a desktop
 * browser and is ignored the moment a real session exists, so the page can never display one
 * identity while `/api/borrow` acts as another.
 */
export async function resolveHolder(raw: string | string[] | undefined): Promise<Holder> {
  try {
    const verified = readVerifiedAddress(await cookies());
    if (verified) return { id: verified, verified: true };
  } catch (err) {
    // No FIAR_SESSION_SECRET configured. Sign-in is unavailable, but browsing public scores is
    // not, so fall through to preview rather than breaking the catalogue.
    if (!(err instanceof AuthConfigError)) throw err;
  }

  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return { id: process.env.FIAR_DEMO_HOLDER ?? "carol.alice.vouchme.eth", verified: false };
  return { id: value.trim() === "" ? null : value.trim(), verified: false };
}
