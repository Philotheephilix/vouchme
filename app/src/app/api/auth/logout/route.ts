import { clearSessionCookies } from "@/lib/authSession";
import { ok } from "@/app/api/_lib/respond";
import { FALLBACK_META } from "@/app/api/_lib/respond";

export const dynamic = "force-dynamic";

function isSecureRequest(req: Request): boolean {
  const proto = req.headers.get("x-forwarded-proto");
  if (proto) return proto.split(",")[0]!.trim() === "https";
  return new URL(req.url).protocol === "https:";
}

/** Clears the verified session (httpOnly, so only the server can do this). Paired with
 *  src/lib/session.tsx's `disconnect()`. */
export async function POST(req: Request): Promise<Response> {
  const response = ok(null, FALLBACK_META);
  clearSessionCookies(response.cookies, isSecureRequest(req));
  return response;
}
