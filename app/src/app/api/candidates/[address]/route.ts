import { CANDIDATES, ME } from "@/lib/mock";
import { decodeParam, ok, fail } from "@/app/api/_lib/respond";

export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }): Promise<Response> {
  const { address } = await params;
  const decoded = decodeParam(address);
  if (!decoded.ok) return decoded.response;
  if (decoded.value !== ME.ensName && decoded.value !== ME.address) {
    return fail(404, "identity_not_found", `No candidate list for "${address}".`);
  }
  return ok(CANDIDATES);
}
