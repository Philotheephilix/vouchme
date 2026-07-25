import { loadAvalData } from "@/lib/mock";
import { fail, ok } from "@/app/api/_lib/respond";

// LIVE mode reads World Chain Sepolia on every request — never cache this route.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const data = await loadAvalData();
    return ok(data.HEALTH, data.meta);
  } catch (err) {
    return fail(503, "chain_unavailable", err instanceof Error ? err.message : "Failed to read live chain data.");
  }
}
