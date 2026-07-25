/**
 * app/src/instrumentation.ts
 *
 * Next.js calls `register()` once per server process, before it serves any request.
 *
 * Why this exists: `chain.ts` accumulates `Enrolled`/`Vouched`/`Reaffirmed`/`Revoked` logs
 * incrementally and keeps them in module state, so warm reads of `/api/identity/*` land in ~0.5s.
 * The *first* read after a cold start is different — it scans from `DEPLOYMENT_BLOCK` to head in
 * 100-block chunks across four event types, measured at ~40s on 2026-07-25.
 *
 * `AppGate` gives the identity check a 15s budget and, correctly, refuses to interpret a timeout
 * as "not enrolled" — so a cold process showed every signed-in member
 * "Can't reach World Chain right now" instead of their dashboard. A cold process is not rare: it
 * happens on every container restart, and under `next dev` on every file edit, because the module
 * cache is discarded.
 *
 * Priming here moves that one-time cost off the user's first request and into boot, where nobody
 * is waiting on it. Deliberately fire-and-forget: a warm-up that cannot reach the RPC must never
 * stop the server from starting — the request path already handles a cold cache correctly, it is
 * just slow, and `getChainHealth()` still reports a genuine outage honestly.
 */

export async function register(): Promise<void> {
  // Only the Node.js server runtime reads the chain; the edge runtime never imports chain.ts.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getChainMode, getLiveGraph } = await import("@/lib/chain");
  if (getChainMode() !== "live") return;

  const startedAt = Date.now();
  void getLiveGraph()
    .then((graph) => {
      console.log(
        `[instrumentation] chain cache warm in ${Date.now() - startedAt}ms ` +
          `(block ${graph.block}, ${graph.engineInput.accounts.length} accounts)`,
      );
    })
    .catch((err: unknown) => {
      console.warn(
        `[instrumentation] chain warm-up failed after ${Date.now() - startedAt}ms — ` +
          `serving cold, first request will be slow: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
}
