import { loadAvalData } from "@/lib/mock";
import { decodeParam, ok, fail } from "@/app/api/_lib/respond";

// LIVE mode reads World Chain Sepolia on every request — never cache this route.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const decoded = decodeParam(id);
  if (!decoded.ok) return decoded.response;
  let data;
  try {
    data = await loadAvalData();
  } catch (err) {
    return fail(503, "chain_unavailable", err instanceof Error ? err.message : "Failed to read live chain data.");
  }
  const identity = data.findIdentity(decoded.value);
  if (!identity) return fail(404, "identity_not_found", `No Aval identity for "${id}".`, data.meta);
  return ok(identity, data.meta);
}
