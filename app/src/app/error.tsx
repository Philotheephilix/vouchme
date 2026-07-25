"use client";

import { WORLDCHAIN } from "@/lib/worldchain";

/** Named from the configured chain, never typed in, so the panel cannot name the wrong network. */
const CHAIN_LABEL = WORLDCHAIN.name;

/**
 * Route-segment error boundary (Next.js App Router convention: `app/error.tsx`).
 *
 * LIVE mode reads World Chain directly on every request — no subgraph buffering the app from an
 * RPC hiccup, and public RPCs rate-limit and lag. Without this boundary a transient
 * `loadVouchMeData()` rejection is an unhandled Server Component error, and Next's default handling
 * discards the whole page tree for this route segment — which reads as "the app crashed" rather
 * than "the chain read failed, retry." The failure is still surfaced honestly, never silently
 * replaced with stale or fixture data — it just happens inside the app's own layout instead of a
 * blank/generic error page.
 */
export default function RouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // Library text (viem's raw RPC errors) belongs in the console; the panel gets one sentence a
  // person can act on.
  if (typeof console !== "undefined") console.error("[vouchme] route error", error);

  return (
    <div className="pb-8" data-testid="route-error">
      <header className="sticky top-0 z-30 bg-void" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="border-b border-rule px-4 py-3">
          <div className="font-mono text-2xs uppercase tracking-widest text-graphite">VOUCHME · ERROR</div>
        </div>
      </header>

      <section className="px-4 pt-6">
        <div className="border px-4 py-3" style={{ borderColor: "var(--color-protest)" }}>
          <p className="font-mono text-2xs uppercase tracking-widest" style={{ color: "var(--color-protest)" }}>
            Could not load live data
          </p>
          <p className="mt-2 text-sm leading-relaxed text-cream">
            World Chain didn&apos;t answer. Your score and your vouches are safe on chain — this screen just
            couldn&apos;t read them.
          </p>
          <p className="mt-2 text-2xs leading-relaxed text-graphite">
            {CHAIN_LABEL} is read directly, live, on every request — a public RPC occasionally rate-limits or lags.
            This is reported rather than papered over with stale or fixture data. The technical detail is in the
            browser console.
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
