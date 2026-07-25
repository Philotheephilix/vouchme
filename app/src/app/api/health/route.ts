import { HEALTH } from "@/lib/mock";
import { ok } from "@/app/api/_lib/respond";

export async function GET(): Promise<Response> {
  return ok(HEALTH);
}
