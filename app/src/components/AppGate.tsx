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

/**
 * The whole app is gated on session + enrollment state:
 *
 *   signed out             -> LoginScreen only. Nothing else renders, on any route.
 *   signed in, unenrolled  -> forced onto /enroll (onboarding). No nav, no other page reachable.
 *   signed in, enrolled    -> the real app: routed page + bottom nav.
 *   signed in, indeterminate -> neither of the above. A retry screen. NEVER routed to /enroll.
 *
 * Enrollment is checked live against `/api/identity/[address]` (backed by `AvalRegistry`'s own
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

  useEffect(() => {
    if (address && status === "not-enrolled" && pathname !== "/enroll") {
      router.replace("/enroll");
    }
  }, [address, status, pathname, router]);

  if (!address) {
    return <LoginScreen />;
  }

  const mainStyle = { paddingBottom: "calc(56px + env(safe-area-inset-bottom))" };

  if (status === "checking") {
    return (
      <main style={mainStyle}>
        <div className="flex min-h-screen items-center justify-center" data-testid="gate-checking">
          <p className="font-mono text-2xs uppercase tracking-widest text-graphite">loading…</p>
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
          <p className="max-w-xs text-sm leading-relaxed text-cream">
            Can&apos;t reach World Chain right now — we couldn&apos;t confirm your account.
          </p>
          <p className="max-w-xs font-mono text-2xs uppercase tracking-widest text-graphite">
            Your identity is safe on chain. This is a network check that failed, not an answer.
          </p>
          <button
            type="button"
            data-testid="gate-retry"
            onClick={retry}
            className="mt-2 min-h-[44px] border px-4 py-3 font-mono text-xs uppercase tracking-widest"
            style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
          >
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
