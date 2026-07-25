import { findIdentity } from "@/lib/mock";
import { ok, fail } from "@/app/api/_lib/respond";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const identity = findIdentity(decodeURIComponent(id));
  if (!identity) return fail(404, "identity_not_found", `No Aval identity for "${id}".`);
  return ok(identity);
}
