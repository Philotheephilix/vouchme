"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/session";
import { LoginScreen } from "./LoginScreen";
import { BottomNav } from "./BottomNav";

type GateStatus = "checking" | "not-enrolled" | "enrolled" | "error";

/** Bounds how long a single identity check can hang before it's treated as indeterminate rather
 *  than an infinite "checking…" spinner — no control should loop forever with no exit.
 *
 *  Deliberately generous: a cold `/api/identity/{addr}` is a full `getLogs` scan from
 *  DEPLOYMENT_BLOCK and can run into the minutes. Concurrent chunk fetches (src/lib/chain.ts) and
 *  a cache primed at boot (src/instrumentation.ts) should keep it far below this ceiling in
 *  practice, and aborting early cannot make the answer arrive sooner — it can only replace a real
 *  answer with a false alarm. */
const IDENTITY_CHECK_TIMEOUT_MS = 120_000;

/** Routes that are public by nature and carry no account data at all.
 *
 *  The gate's rule is "nothing renders until someone is signed in", and that rule exists to protect
 *  *somebody's* data. `/pitch` is a static, presenter-free explanation of the protocol and `/landing`
 *  is the public marketing page — neither reads a session, chain state or an identity, so there is
 *  nothing on either to protect, and putting a sign-in wall in front of an explanation of what the
 *  app is defeats the only reason those pages exist. Both render their own full-width chrome, so
 *  they take neither the `<main>` padding nor the bottom nav. */
const PUBLIC_ROUTES = new Set(["/pitch", "/landing"]);

/** The mini-app column. A constant, so it lives at module scope rather than forcing every early
 *  return in the component to be ordered after its declaration. */
const mainStyle = {
  paddingBottom: "calc(104px + env(safe-area-inset-bottom))",
  maxWidth: 480,
  width: "100%",
  margin: "0 auto",
} as const;

/**
 * The whole app is gated on session + enrollment state:
 *
 *   signed out             -> LoginScreen only. Nothing else renders, on any route.
 *   signed in, unenrolled  -> forced onto /enroll (onboarding). No nav, no other page reachable.
 *   signed in, enrolled    -> the real app: routed page + bottom nav.
 *   signed in, indeterminate -> neither of the above. A retry screen. NEVER routed to /enroll.
 *
 * Enrollment is checked live against `/api/identity/[address]` (backed by `VouchMeRegistry`'s own
 * `Enrolled` events via chain.ts). That route answers three ways, and only one of them means
 * "not enrolled":
 *
 *   200            -> enrolled.
 *   404            -> a real, explicit "no Enrolled record for this address" answer -> not enrolled.
 *   anything else  -> the check FAILED (5xx from an RPC blip, a network error, a timeout, a
 *                     response that doesn't even parse as the expected envelope). This is not
 *                     the same fact as 404 and must never be treated as one: reading a flaky RPC
 *                     call as "you have no account" silently disowns real enrolled members and
 *                     pushes them onto /enroll with an empty handle box, inviting them to mint a
 *                     second identity. So: 404 routes to /enroll; nothing else ever does. A
 *                     failed check shows a retry screen and holds the user exactly where they
 *                     were.
 *
 * Re-run whenever the signed-in address changes (including right after a fresh sign-in) so a
 * switch of account, or enrolling in another tab, is picked up rather than cached.
 */
export function AppGate({ children }: { children: ReactNode }) {
  const { address } = useAuth();
  const pathname = usePathname();
  const router = useRouter();

  const [status, setStatus] = useState<GateStatus>("checking");
  const [attempt, setAttempt] = useState(0);
  const generationRef = useRef(0);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  useEffect(() => {
    if (!address) {
      setStatus("checking");
      return;
    }
    const generation = ++generationRef.current;
    setStatus("checking");

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), IDENTITY_CHECK_TIMEOUT_MS);

    (async () => {
      let res: Response;
      try {
        res = await fetch(`/api/identity/${encodeURIComponent(address)}`, { signal: controller.signal });
      } catch {
        // Network failure, abort/timeout, DNS error, etc. — no answer at all, not a "no."
        if (generationRef.current === generation) setStatus("error");
        return;
      }

      if (res.status === 404) {
        // The one real, explicit "not enrolled" answer.
        if (generationRef.current === generation) setStatus("not-enrolled");
        return;
      }

      if (!res.ok) {
        // 5xx, 4xx other than 404, etc. — the check failed, it did not return an answer.
        if (generationRef.current === generation) setStatus("error");
        return;
      }

      try {
        const body: unknown = await res.json();
        const hasData =
          typeof body === "object" && body !== null && "data" in body && (body as { data?: unknown }).data != null;
        if (generationRef.current === generation) setStatus(hasData ? "enrolled" : "error");
      } catch {
        // 200 with a malformed/unparseable body — still can't confirm enrollment.
        if (generationRef.current === generation) setStatus("error");
      }
    })();

    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [address, attempt]);

  // `PUBLIC_ROUTES` has to be honoured HERE as well as in the render below, and forgetting it here
  // is why /pitch used to bounce to /enroll a moment after it appeared. The early return for public
  // routes cannot prevent this: it sits below every hook (deliberately, for stable hook order), so
  // this effect still runs on /pitch and still fired the redirect. The deck rendered, `status`
  // resolved to "not-enrolled" a beat later, and the reader was yanked to onboarding mid-slide.
  //
  // Slides are hash fragments, so `pathname` stays "/pitch" throughout — the bounce landed once,
  // wherever in the deck the reader happened to be.
  useEffect(() => {
    if (PUBLIC_ROUTES.has(pathname)) return;
    if (address && status === "not-enrolled" && pathname !== "/enroll") {
      router.replace("/enroll");
    }
  }, [address, status, pathname, router]);

  // Public routes render themselves, signed in or not. Placed after every hook so the hook order
  // is identical on every route, and before the sign-in wall so `/pitch` is reachable by someone
  // who has no wallet and no account — which is exactly who a pitch deck is for.
  if (PUBLIC_ROUTES.has(pathname)) {
    return <>{children}</>;
  }

  // Local browser-preview bypass: skip the sign-in + enrollment gate so the UI renders in a plain
  // browser with no World App.
  //
  // Moved BELOW the hooks and below the public-route check, and guarded on NODE_ENV. All three
  // matter:
  //  - Above the hooks it was an early return before `useState`, so the moment anyone made the
  //    condition non-constant the hook order would change between renders and React would throw.
  //  - Above the public-route check it wrapped /landing and /pitch in the 480px mini-app shell
  //    plus a bottom nav, which is the wrong chrome for a page meant to be shown to the public.
  //  - Ungated it was a real hazard: the matching bypass in `readVerifiedAddress` compiles to a
  //    live `process.env` read on the server, so a stray env var on a deploy served signed-in
  //    pages to anonymous requests with no rebuild. `NODE_ENV` is set by `next build`/`next start`
  //    and is the one condition a misconfigured environment cannot flip.
  if (process.env.NODE_ENV !== "production" && process.env.NEXT_PUBLIC_PREVIEW === "1") {
    return (
      <>
        <main style={mainStyle}>{children}</main>
        <BottomNav />
      </>
    );
  }

  if (!address) {
    return <LoginScreen />;
  }

  if (status === "checking") {
    return (
      <main style={mainStyle}>
        <div className="flex min-h-screen items-center justify-center" data-testid="gate-checking">
          <span className="eyebrow inline-flex items-center gap-2">
            <span className="dot dot-pulse text-seal" />
            Loading
          </span>
        </div>
      </main>
    );
  }

  if (status === "error") {
    // Explicitly NOT the /enroll bounce: we could not determine enrollment, so we claim nothing
    // about it. Keep the user here and offer a way to re-run the check.
    return (
      <main style={mainStyle}>
        <div
          className="flex min-h-screen flex-col items-center justify-center gap-4 px-6 text-center"
          data-testid="gate-error"
        >
          <p className="max-w-xs text-base leading-relaxed text-cream">
            Can&apos;t reach World Chain right now — we couldn&apos;t confirm your account.
          </p>
          <p className="max-w-xs text-2xs leading-relaxed text-graphite">
            Your identity is safe on chain. This is a network check that failed, not an answer.
          </p>
          <button type="button" data-testid="gate-retry" onClick={retry} className="btn btn-secondary mt-2">
            Retry
          </button>
        </div>
      </main>
    );
  }

  if (status === "not-enrolled") {
    // Held here until the redirect above lands — no nav, no other page reachable while
    // onboarding. The enroll page itself renders the World ID -> handle -> enroll() -> mint flow.
    if (pathname !== "/enroll") return null;
    return <main style={mainStyle}>{children}</main>;
  }

  return (
    <>
      <main style={mainStyle}>{children}</main>
      <BottomNav />
    </>
  );
}
