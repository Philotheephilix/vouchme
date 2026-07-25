import { checkGate } from "@/lib/mock";
import type { GatePolicy } from "@/lib/types";
import { ok, fail } from "@/app/api/_lib/respond";

interface GateRequestBody {
  address?: string;
  policy?: GatePolicy;
}

export async function POST(req: Request): Promise<Response> {
  let body: GateRequestBody;
  try {
    body = (await req.json()) as GateRequestBody;
  } catch {
    return fail(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!body.address) return fail(400, "missing_address", "`address` is required.");
  const result = checkGate(body.address, body.policy ?? {});
  return ok(result);
}
