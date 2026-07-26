/**
 * app/src/instrumentation.ts
 *
 * Next.js calls `register()` once per server process, before it serves any request.
 *
 * Why this exists: `chain.ts` accumulates `Enrolled`/`Vouched`/`Reaffirmed`/`Revoked` logs
 * incrementally and keeps them in memory, so warm reads of `/api/identity/*` land in well under a
 * second. The *first* read after a cold start is different — it scans from `DEPLOYMENT_BLOCK` to
 * head across nine event types, which takes seconds and grows with every day the deployment lives.
 * That is longer than the 15s budget `AppGate` gives the identity check, and a timeout there is
 * correctly not treated as "not enrolled". A cold process is not rare: it happens on every
 * container restart, and under `next dev` on every file edit.
 *
 * Priming here moves that one-time cost off the user's first request and into boot, where nobody is
 * waiting on it.
 *
 * This only works because `chain.ts` keeps its caches on a `globalThis` symbol rather than in
 * module-level variables. Next.js compiles this file into its own webpack bundle, so the built
 * server contains two copies of `chain.ts` — one reachable from here, a different one from the API
 * routes. With per-module state the warm-up filled a cache no request handler could read, and
 * logged a cheerful "chain cache warm in 6618ms" while every request still paid the full cold scan.
 * See `ChainState` in `src/lib/chain.ts`; do not "simplify" that back into module-level `let`s.
 *
 * Deliberately fire-and-forget: a warm-up that cannot reach the RPC must never stop the server from
 * starting — the request path already handles a cold cache correctly, it is just slow, and
 * `getChainHealth()` still reports a genuine outage honestly. One retry, because the usual reason a
 * boot-time warm-up fails is a provider throttling the burst, and giving up on the first 429 leaves
 * the cache cold for the first real user — the precise cost this file exists to avoid.
 */

const WARM_RETRY_DELAY_MS = 5_000;

export async function register(): Promise<void> {
  // Only the Node.js server runtime reads the chain; the edge runtime never imports chain.ts.
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { getChainMode, getLiveGraph } = await import("@/lib/chain");
  if (getChainMode() !== "live") return;

  const startedAt = Date.now();

  const warm = async (attempt: number): Promise<void> => {
    try {
      const graph = await getLiveGraph();
      console.log(
        `[instrumentation] chain cache warm in ${Date.now() - startedAt}ms ` +
          `(block ${graph.block}, ${graph.engineInput.accounts.length} accounts)`,
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === 0) {
        console.warn(`[instrumentation] chain warm-up attempt failed, retrying once: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, WARM_RETRY_DELAY_MS));
        return warm(attempt + 1);
      }
      console.warn(
        `[instrumentation] chain warm-up failed after ${Date.now() - startedAt}ms — ` +
          `serving cold, first request will be slow: ${message}`,
      );
    }
  };

  void warm(0);
}
