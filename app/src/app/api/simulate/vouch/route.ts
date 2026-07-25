import { loadAvalData } from "@/lib/mock";
import { isJsonObject, ok, fail } from "@/app/api/_lib/respond";

interface SimulateVouchBody {
  voucher?: string;
  target?: string;
}

// LIVE mode reads World Chain Sepolia on every request — never cache this route.
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "invalid_json", "Request body must be valid JSON.");
  }
  // JSON `null` (and arrays/primitives) parse successfully — only malformed JSON *text* throws,
  // which the try/catch above already handles — so this must be checked separately, before any
  // property access.
  if (!isJsonObject(parsed)) return fail(400, "invalid_body", "Request body must be a JSON object.");
  const body = parsed as SimulateVouchBody;
  if (!body.voucher || !body.target) {
    return fail(400, "missing_fields", "`voucher` and `target` are both required.");
  }
  let data;
  try {
    data = await loadAvalData();
  } catch (err) {
    return fail(503, "chain_unavailable", err instanceof Error ? err.message : "Failed to read live chain data.");
  }
  const result = data.simulateVouch(body.voucher, body.target);
  return ok(result, data.meta);
}
