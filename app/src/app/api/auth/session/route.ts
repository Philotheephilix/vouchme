import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { readVerifiedAddress } from "@/lib/authSession";

/**
 * Who does the SERVER believe is signed in?
 *
 * `MiniKit.user.walletAddress` and the plain `aval_addr` cookie are client-side facts, and neither
 * implies the httpOnly `aval_session` cookie that every server-rendered page actually authorizes
 * against — so a client answering this itself can disagree with what those pages do.
 *
 * This route makes the server the single source of truth. It reveals nothing a caller doesn't
 * already have — it can only ever echo back the address in the caller's own signed cookie.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const cookieStore = await cookies();
  const address = readVerifiedAddress(cookieStore);
  // Deliberately not the shared `ok()` envelope: that requires an ApiMeta describing chain/indexer
  // state, and this route must answer even when the chain is unreachable — sign-in is exactly what
  // a user needs when things are degraded.
  return NextResponse.json({ data: { address: address ?? null, verified: address !== null } });
}
