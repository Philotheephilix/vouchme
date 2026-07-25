import { loadAvalData } from "@/lib/mock";
import { decodeParam, ok, fail } from "@/app/api/_lib/respond";

// LIVE mode reads World Chain Sepolia on every request — never cache this route.
export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }): Promise<Response> {
  const { address } = await params;
  const decoded = decodeParam(address);
  if (!decoded.ok) return decoded.response;
  let data;
  try {
    data = await loadAvalData();
  } catch (err) {
    return fail(503, "chain_unavailable", err instanceof Error ? err.message : "Failed to read live chain data.");
  }
  const result = data.getScoreResult(decoded.value);
  if (!result) return fail(404, "identity_not_found", `No Aval score for "${address}".`, data.meta);
  return ok(result, data.meta);
}
