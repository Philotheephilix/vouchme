import "server-only";

import type { NextRequest } from "next/server";
import { loadVouchMeData } from "@/lib/mock";
import { fail, ok, FALLBACK_META } from "@/app/api/_lib/respond";

// LIVE mode reads World Chain Sepolia on every request — never cache this route.
export const dynamic = "force-dynamic";

// docs/04-ens.md §6 / docs/10-constants.md §6: "[a-z0-9-], 3-20 chars, ENSIP-15 normalized."
// ENSIP-15 exists to reject Unicode homograph/confusable attacks; a pure ASCII [a-z0-9-] string
// has no Unicode to be confusable in the first place, so restricting the charset up front already
// satisfies ENSIP-15's intent for this label set without pulling in a full normalization library.
const HANDLE_RE = /^[a-z0-9-]{3,20}$/;

export interface HandleCheckResult {
  handle: string;
  available: boolean;
  reason: string | null;
}

export async function GET(req: NextRequest): Promise<Response> {
  const raw = req.nextUrl.searchParams.get("h") ?? "";
  const handle = raw.trim().toLowerCase();

  if (!handle) return fail(400, "missing_handle", "`h` query parameter is required.");
  if (!HANDLE_RE.test(handle)) {
    return ok<HandleCheckResult>(
      { handle, available: false, reason: "3-20 characters, lowercase a-z, 0-9 and hyphen only." },
      FALLBACK_META,
    );
  }
  if (handle.startsWith("-") || handle.endsWith("-")) {
    return ok<HandleCheckResult>({ handle, available: false, reason: "cannot start or end with a hyphen." }, FALLBACK_META);
  }

  let data;
  try {
    data = await loadVouchMeData();
  } catch (err) {
    return fail(503, "chain_unavailable", err instanceof Error ? err.message : "Failed to read live chain data.");
  }

  const full = `${handle}.vouchme.eth`;
  // Advisory only (docs/04-ens.md §6: "Uniqueness: per parent; globally advisory" — VouchMeRegistry
  // itself does not enforce handle uniqueness on-chain; a real ENS registrar would). Checked
  // against every currently-enrolled handle so two people don't collide by accident.
  const taken = data.findIdentity(full) !== undefined;
  return ok<HandleCheckResult>(
    { handle, available: !taken, reason: taken ? `"${full}" is already taken.` : null },
    data.meta,
  );
}
