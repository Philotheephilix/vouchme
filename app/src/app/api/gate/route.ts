import { checkGate } from "@/lib/mock";
import type { GatePolicy } from "@/lib/types";
import { isJsonObject, ok, fail } from "@/app/api/_lib/respond";

interface GateRequestBody {
  address?: string;
  policy?: GatePolicy;
}

export async function POST(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "invalid_json", "Request body must be valid JSON.");
  }
  // R-10 (docs/97-review-engine-app.md): JSON `null` (and arrays/primitives) parse successfully —
  // only malformed JSON *text* throws, which the try/catch above already handles — so this must be
  // checked separately, before any property access.
  if (!isJsonObject(parsed)) return fail(400, "invalid_body", "Request body must be a JSON object.");
  const body = parsed as GateRequestBody;
  if (!body.address) return fail(400, "missing_address", "`address` is required.");
  const result = checkGate(body.address, body.policy ?? {});
  return ok(result);
}
