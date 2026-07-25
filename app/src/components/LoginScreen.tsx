"use client";

import { useAuth } from "@/lib/session";

/** The entire signed-out experience. No score, no dial, no endorsement rows, no other user's
 *  data — nothing renders until someone is signed in (product direction: "the first page should
 *  be login and without it don't show anything"). */
export function LoginScreen() {
  const { connecting, error, connect, clearError } = useAuth();

  return (
    <main
      data-testid="login-screen"
      className="flex min-h-screen flex-col items-center justify-center px-4 text-center"
      style={{ paddingBottom: "env(safe-area-inset-bottom)", paddingTop: "env(safe-area-inset-top)" }}
    >
      <h1 className="font-serif text-cream" style={{ fontSize: "var(--text-2xl)" }}>
        Aval
      </h1>
      <p className="mx-auto mt-3 max-w-xs text-sm leading-relaxed text-cream">
        A trust graph grounded in one human, one account. Proof of human is a floor. This is the
        ladder.
      </p>
      <button
        type="button"
        data-testid="login-signin"
        onClick={() => void connect()}
        disabled={connecting}
        className="mt-10 min-h-[44px] w-full max-w-xs border px-4 py-3 font-mono text-xs uppercase tracking-widest disabled:opacity-50"
        style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
      >
        {connecting ? "Connecting…" : "Sign in with World"}
      </button>
      {error ? (
        <button
          type="button"
          onClick={clearError}
          className="mt-4 max-w-xs text-2xs leading-snug"
          style={{ color: "var(--color-protest)" }}
        >
          {error}
        </button>
      ) : null}
    </main>
  );
}
