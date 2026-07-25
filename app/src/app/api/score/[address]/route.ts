import { getScoreResult } from "@/lib/mock";
import { ok, fail } from "@/app/api/_lib/respond";

export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }): Promise<Response> {
  const { address } = await params;
  const result = getScoreResult(decodeURIComponent(address));
  if (!result) return fail(404, "identity_not_found", `No Aval score for "${address}".`);
  return ok(result);
}
