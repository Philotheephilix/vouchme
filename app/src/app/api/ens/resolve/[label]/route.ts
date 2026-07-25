import "server-only";

import { resolveEnsLabel } from "@/lib/ens";
import { decodeParam, ok, fail, FALLBACK_META } from "@/app/api/_lib/respond";

export const dynamic = "force-dynamic";

/** Independent readback: what `<label>.aval.eth` actually resolves to right now, read live from
 *  the resolver on Ethereum Sepolia — not the UI's own claim about what it just minted. */
export async function GET(_req: Request, { params }: { params: Promise<{ label: string }> }): Promise<Response> {
  const { label } = await params;
  const decoded = decodeParam(label);
  if (!decoded.ok) return decoded.response;

  try {
    const address = await resolveEnsLabel(decoded.value);
    return ok({ label: decoded.value, handle: `${decoded.value}.aval.eth`, address }, FALLBACK_META);
  } catch (err) {
    return fail(502, "ens_resolve_failed", err instanceof Error ? err.message : "Failed to resolve on Ethereum Sepolia.");
  }
}
