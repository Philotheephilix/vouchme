import { simulateVouch } from "@/lib/mock";
import { ok, fail } from "@/app/api/_lib/respond";

interface SimulateVouchBody {
  voucher?: string;
  target?: string;
}

export async function POST(req: Request): Promise<Response> {
  let body: SimulateVouchBody;
  try {
    body = (await req.json()) as SimulateVouchBody;
  } catch {
    return fail(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!body.voucher || !body.target) {
    return fail(400, "missing_fields", "`voucher` and `target` are both required.");
  }
  const result = simulateVouch(body.voucher, body.target);
  return ok(result);
}
