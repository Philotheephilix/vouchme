import { explainProse } from "@/lib/mock";
import { ok, fail } from "@/app/api/_lib/respond";

export async function GET(_req: Request, { params }: { params: Promise<{ address: string }> }): Promise<Response> {
  const { address } = await params;
  const prose = explainProse(decodeURIComponent(address));
  if (!prose) return fail(404, "identity_not_found", `No Aval score for "${address}".`);
  return ok({ prose });
}
