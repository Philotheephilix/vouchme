"use client";

import { useState } from "react";
import { useAuth } from "@/lib/session";
import { truncateMiddle } from "@/lib/format";

/** Signed-out shows `Sign in`; signed-in shows the truncated address and a sign-out control.
 *  The one place in the header that answers "who is using this app right now". */
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
          className="btn btn-primary"
          style={{ height: 32, padding: "0 12px" }}
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
            className="max-w-[220px] text-right font-mono text-2xs leading-snug text-protest"
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
      <span className="truncate-mono max-w-[120px] font-mono text-2xs text-graphite" data-testid="account-address">
        {truncateMiddle(address, 12)}
      </span>
      <button
        type="button"
        data-testid="sign-out"
        onClick={disconnect}
        className="btn btn-ghost"
        style={{ height: 32, padding: "0 10px" }}
      >
        Sign out
      </button>
    </div>
  );
}
