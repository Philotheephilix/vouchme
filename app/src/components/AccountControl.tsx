"use client";

import { useState } from "react";
import { useAuth } from "@/lib/session";
import { truncateMiddle } from "@/lib/format";

/** Signed-out shows `Sign in`; signed-in shows the truncated address and a sign-out control.
 *  The one place in the header that answers "who is using this app right now" (task correction
 *  §1 — the missing foundation). */
export function AccountControl() {
  const { address, connecting, error, connect, disconnect, clearError } = useAuth();
  const [showError, setShowError] = useState(true);

  if (!address) {
    return (
      <div className="flex flex-col items-end gap-1">
        <button
          type="button"
          data-testid="sign-in"
          onClick={() => {
            setShowError(true);
            void connect();
          }}
          disabled={connecting}
          className="min-h-[36px] border px-3 font-mono text-2xs uppercase tracking-widest disabled:opacity-50"
          style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
        >
          {connecting ? "Connecting…" : "Sign in"}
        </button>
        {error && showError ? (
          <button
            type="button"
            data-testid="sign-in-error"
            onClick={() => {
              setShowError(false);
              clearError();
            }}
            className="max-w-[220px] text-right font-mono text-2xs leading-snug"
            style={{ color: "var(--color-protest)" }}
            title="Dismiss"
          >
            {error}
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2" data-testid="account-control">
      <span className="font-mono text-2xs text-cream" data-testid="account-address">
        {truncateMiddle(address, 14)}
      </span>
      <button
        type="button"
        data-testid="sign-out"
        onClick={disconnect}
        className="min-h-[36px] border px-2 font-mono text-2xs uppercase tracking-widest text-graphite"
        style={{ borderColor: "var(--color-rule)" }}
      >
        Sign out
      </button>
    </div>
  );
}
