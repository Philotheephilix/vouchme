import { findIdentity } from "@/lib/mock";
import { decodeParam, ok, fail } from "@/app/api/_lib/respond";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await params;
  const decoded = decodeParam(id);
  if (!decoded.ok) return decoded.response;
  const identity = findIdentity(decoded.value);
  if (!identity) return fail(404, "identity_not_found", `No Aval identity for "${id}".`);
  return ok(identity);
}
