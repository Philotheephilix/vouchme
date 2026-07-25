import { simulateVouch } from "@/lib/mock";
import { isJsonObject, ok, fail } from "@/app/api/_lib/respond";

interface SimulateVouchBody {
  voucher?: string;
  target?: string;
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
  const body = parsed as SimulateVouchBody;
  if (!body.voucher || !body.target) {
    return fail(400, "missing_fields", "`voucher` and `target` are both required.");
  }
  const result = simulateVouch(body.voucher, body.target);
  return ok(result);
}
