import { loadVouchMeData } from "@/lib/mock";
import { decodeParam, ok, fail } from "@/app/api/_lib/respond";

// LIVE mode reads World Chain Sepolia on every request — never cache this route.
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ from: string; to: string }> },
): Promise<Response> {
  const { from, to } = await params;
  const decodedFrom = decodeParam(from);
  if (!decodedFrom.ok) return decodedFrom.response;
  const decodedTo = decodeParam(to);
  if (!decodedTo.ok) return decodedTo.response;
  const fromName = decodedFrom.value;
  const toName = decodedTo.value; // may be the literal "anchor" — docs/07-app-api.md §3
  let data;
  try {
    data = await loadVouchMeData();
  } catch (err) {
    return fail(503, "chain_unavailable", err instanceof Error ? err.message : "Failed to read live chain data.");
  }
  const result = data.findPath(fromName, toName);
  if (result.hops.length === 0) return fail(404, "identity_not_found", `No VouchMe identity for "${fromName}".`, data.meta);
  return ok(result, data.meta);
}
