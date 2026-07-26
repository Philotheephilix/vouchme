"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { activeMiniKit, Command, commandAvailability, ensureMiniKit, inWorldAppNow } from "@/lib/minikit";

/**
 * Sign in with World.
 *
 * The nonce comes from the server. A locally generated one proves nothing — the server would be
 * checking a challenge the client chose — and the signature is verified server-side against the
 * chain, because World App wallets are contract accounts.
 */
export function SignIn() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Install as early as possible: the handshake takes a moment, and doing it on mount means the
  // command is usually already available by the time somebody taps.
  useEffect(() => {
    if (inWorldAppNow()) void ensureMiniKit();
  }, []);

  async function signIn() {
    setBusy(true);
    setError(null);
    try {
      if (!inWorldAppNow()) {
        setError("Open this inside World App.");
        return;
      }
      // Re-checked here and not only on mount: a page reload resets this module's state, so the
      // mount-time install may belong to a previous page.
      const install = await ensureMiniKit();
      if (!install.ok) {
        setError(install.detail);
        return;
      }
      const availability = commandAvailability(Command.WalletAuth);
      if (!availability.available) {
        setError(availability.reason);
        return;
      }

      const nonceRes = await fetch("/api/auth/nonce", { method: "POST" });
      const nonce = await nonceRes.json();
      if (!nonceRes.ok) {
        setError(nonce?.error ?? "Could not start sign-in.");
        return;
      }

      const result = await activeMiniKit().walletAuth({
        nonce: nonce.nonce,
        statement: "Prove this wallet is yours.",
      });
      const payload = result?.data;
      if (!payload?.address || !payload.signature || !payload.message) {
        setError("Sign-in was dismissed.");
        return;
      }

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: payload.address,
          message: payload.message,
          signature: payload.signature,
          nonce,
        }),
      });
      const verified = await verifyRes.json();
      if (!verifyRes.ok) {
        setError(verified?.error ?? "Could not verify that signature.");
        return;
      }
      // Drop any `?as=` preview: a verified session outranks it, and leaving it in the URL would
      // show one identity while the server acts as another.
      router.replace(window.location.pathname);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button type="button" className="btn btn-wide" onClick={signIn} disabled={busy}>
        {busy ? "Signing in…" : "Sign in with World"}
      </button>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SignOut() {
  const router = useRouter();
  return (
    <button
      type="button"
      className="btn btn-quiet"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
