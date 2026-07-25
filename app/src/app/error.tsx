"use client";

/**
 * Route-segment error boundary (Next.js App Router convention: `app/error.tsx`).
 *
 * LIVE mode reads World Chain Sepolia directly on every request — no subgraph buffering the
 * app from an RPC hiccup. Public RPCs rate-limit and lag (task brief, and observed firsthand
 * under concurrent load in this environment): without this boundary, a transient
 * `loadAvalData()` rejection is an unhandled Server Component error, and Next's default handling
 * discards the whole page tree for this route segment — which reads as "the app crashed" rather
 * than "the chain read failed, retry." This still surfaces the failure honestly (task
 * requirement: never silently fall back to fixtures) — it just does so inside the app's own
 * layout instead of a blank/generic error page.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="pb-8" data-testid="route-error">
      <header className="sticky top-0 z-30 bg-void" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="border-b border-rule px-4 py-3">
          <div className="font-mono text-2xs uppercase tracking-widest text-graphite">AVAL · ERROR</div>
        </div>
      </header>

      <section className="px-4 pt-6">
        <div className="border px-4 py-3" style={{ borderColor: "var(--color-protest)" }}>
          <p className="font-mono text-2xs uppercase tracking-widest" style={{ color: "var(--color-protest)" }}>
            Could not load live data
          </p>
          <p className="mt-2 text-sm leading-relaxed text-cream">{error.message || "Unknown error."}</p>
          <p className="mt-2 text-2xs leading-relaxed text-graphite">
            World Chain Sepolia is read directly, live, on every request — a public RPC occasionally rate-limits or
            lags. This is reported rather than papered over with stale or fixture data.
          </p>
        </div>
        <button
          type="button"
          onClick={reset}
          className="mt-4 min-h-[44px] w-full border px-4 py-3 font-mono text-xs uppercase tracking-widest"
          style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
        >
          Retry
        </button>
      </section>
    </div>
  );
}
