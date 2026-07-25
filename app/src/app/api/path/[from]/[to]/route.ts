import { findPath } from "@/lib/mock";
import { ok, fail } from "@/app/api/_lib/respond";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ from: string; to: string }> },
): Promise<Response> {
  const { from, to } = await params;
  const fromName = decodeURIComponent(from);
  const toName = decodeURIComponent(to); // may be the literal "anchor" — docs/07-app-api.md §3
  const result = findPath(fromName, toName);
  if (result.hops.length === 0) return fail(404, "identity_not_found", `No Aval identity for "${fromName}".`);
  return ok(result);
}
