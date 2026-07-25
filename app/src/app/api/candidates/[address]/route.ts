import { CANDIDATES, ME } from "@/lib/mock";
import { ok, fail } from "@/app/api/_lib/respond";

export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }): Promise<Response> {
  const { address } = await params;
  const decoded = decodeURIComponent(address);
  if (decoded !== ME.ensName && decoded !== ME.address) {
    return fail(404, "identity_not_found", `No candidate list for "${address}".`);
  }
  return ok(CANDIDATES);
}
