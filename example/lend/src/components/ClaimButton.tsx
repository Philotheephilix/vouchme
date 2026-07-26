"use client";

import { useState } from "react";
import type { PoolId } from "@/lib/pools";

/**
 * Claim.
 *
 * Sends nothing but the pool id. The recipient is the session address, decided on the server; an
 * address in this request would be an address a client could choose.
 *
 * The server may refuse a pool this page drew as open — standing is revocable in one tap. When it
 * does, its sentence is shown as-is rather than a generic failure, because "Standard requires
 * Tier 2" is actionable and "something went wrong" is not.
 */
export function ClaimButton({ pool }: { pool: PoolId }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pool }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Claim failed.");
        return;
      }
      setTxHash(data.txHash);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim failed.");
    } finally {
      setBusy(false);
    }
  }

  if (txHash) {
    return (
      <a className="sent" href={`https://worldscan.org/tx/${txHash}`} target="_blank" rel="noreferrer">
        Sent
      </a>
    );
  }

  if (error) {
    return (
      <span className="error error-inline" role="alert">
        {error}
      </span>
    );
  }

  return (
    <button type="button" className="btn" onClick={claim} disabled={busy}>
      {busy ? "Sending…" : "Claim"}
    </button>
  );
}
