"use client";

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/lib/session";
import { LoginScreen } from "./LoginScreen";
import { BottomNav } from "./BottomNav";

type GateStatus = "checking" | "not-enrolled" | "enrolled";

/**
 * The whole app is gated on session + enrollment state (product direction, superseding the
 * earlier "labelled demo view" — that idea is gone):
 *
 *   signed out             -> LoginScreen only. Nothing else renders, on any route.
 *   signed in, unenrolled  -> forced onto /enroll (onboarding). No nav, no other page reachable.
 *   signed in, enrolled    -> the real app: routed page + bottom nav.
 *
 * Enrollment is checked live against `/api/identity/[address]` (backed by `AvalRegistry`'s own
 * `Enrolled` events via chain.ts) — 404 means "no Enrolled record," 200 means enrolled. Re-run
 * whenever the signed-in address changes (including right after a fresh sign-in) so a switch of
 * account, or enrolling in another tab, is picked up rather than cached.
 */
export function AppGate({ children }: { children: ReactNode }) {
  const { address } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [status, setStatus] = useState<GateStatus>("checking");

  useEffect(() => {
    if (!address) {
      setStatus("checking");
      return;
    }
    let cancelled = false;
    setStatus("checking");
    (async () => {
      try {
        const res = await fetch(`/api/identity/${encodeURIComponent(address)}`);
        if (!cancelled) setStatus(res.ok ? "enrolled" : "not-enrolled");
      } catch {
        if (!cancelled) setStatus("not-enrolled");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [address]);

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
