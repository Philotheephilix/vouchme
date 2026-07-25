import { loadVouchMeData } from "@/lib/mock";
import type { GatePolicy } from "@/lib/types";
import { isJsonObject, ok, fail } from "@/app/api/_lib/respond";

interface GateRequestBody {
  address?: string;
  policy?: GatePolicy;
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
  const body = parsed as GateRequestBody;
  if (!body.address) return fail(400, "missing_address", "`address` is required.");
  let data;
  try {
    data = await loadVouchMeData();
  } catch (err) {
    return fail(503, "chain_unavailable", err instanceof Error ? err.message : "Failed to read live chain data.");
  }
  const result = data.checkGate(body.address, body.policy ?? {});
  return ok(result, data.meta);
}
