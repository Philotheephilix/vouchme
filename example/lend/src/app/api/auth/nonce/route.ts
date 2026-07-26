import { AuthConfigError, issueNonce } from "@/lib/session";

/** A challenge is only a challenge if it is fresh, so this must never be cached. */
export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  try {
    return Response.json(issueNonce(), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof AuthConfigError) {
      return Response.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
