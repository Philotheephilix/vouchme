"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { IDKit, identityCheck, type IDKitResult, type IdentityAttribute } from "@worldcoin/idkit-core";
import { JURISDICTION_NAMES, SERVED_JURISDICTIONS, type Alpha3 } from "@/lib/identity";
import type { PoolId } from "@/lib/pools";

/**
 * The screen that asks a person to prove something about their ID.
 *
 * Three principles, all of which cost something and all of which are the point:
 *
 *  1. **Consent is shown before the request is made, not after.** The attributes come from the
 *     server (`/api/identity/challenge`), which also returns the exact sentences to display, so the
 *     copy and the payload are generated from one policy object and cannot drift apart. The user
 *     reads what will be asked, then decides.
 *
 *  2. **What is NOT shared is stated as plainly as what is.** A person who reads "we check you are
 *     over 18" has no way to tell whether their name came too. They cannot see the payload, so the
 *     screen has to tell them, and vaguely reassuring language does not count.
 *
 *  3. **The result proves nothing here.** This component posts the IDKit result to the server and
 *     then does exactly what the server says. `result.identity_attested` is deliberately never read
 *     in this file — it is a field a browser can write.
 */

interface ConsentCopy {
  shares: string[];
  withholds: string[];
  summary: string;
}

interface Challenge {
  app_id: `app_${string}`;
  action: string;
  rp_context: { rp_id: string; nonce: string; created_at: number; expires_at: number; signature: string };
  attributes: IdentityAttribute[];
  signal: string;
  consent: ConsentCopy;
}

type Phase = "idle" | "choosing" | "consenting" | "running" | "done" | "error";

export function IdentityCheck({ pool, needsJurisdiction }: { pool: PoolId; needsJurisdiction: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [country, setCountry] = useState<Alpha3 | "">("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [connectorURI, setConnectorURI] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Ask the server what may be requested. It may refuse outright — an unserved jurisdiction is
   *  refused HERE, before World is contacted, so nobody outside the licensed area is ever asked to
   *  open their document. */
  async function prepare(selected: Alpha3 | null) {
    setError(null);
    setPhase("running");
    try {
      const res = await fetch("/api/identity/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pool, country: selected }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not start the identity check.");
        setPhase("error");
        return;
      }
      setChallenge(data as Challenge);
      setPhase("consenting");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the identity check.");
      setPhase("error");
    }
  }

  async function run() {
    if (!challenge) return;
    setError(null);
    setPhase("running");
    try {
      const request = await IDKit.request({
        app_id: challenge.app_id,
        action: challenge.action,
        rp_context: challenge.rp_context,
        // Only World ID 4.0. A legacy 3.0 proof cannot carry an identity attestation at all, so
        // accepting one would mean accepting a proof of something we did not ask about.
        //
        // NOTE, and it matters: on the bridge transport idkit-core 4.2.2 puts
        // `allow_legacy_proofs: true` on the wire for every v4 preset regardless of what is set
        // here. Reproduce with `npm run test:probe`. The server therefore does not rely on this —
        // `/api/identity` rejects any result whose `protocol_version` is not "4.0".
        allow_legacy_proofs: false,
      }).preset(
        identityCheck({
          // Exactly the attributes the server chose for this pool. Not a superset, and not a
          // hardcoded list that could drift from the policy.
          attributes: challenge.attributes,
          // The only signal parameter `identityCheck` exposes. Binds the proof to this attempt.
          legacy_signal: challenge.signal,
        }),
      );

      // Outside World App the flow is a QR/deeplink handoff, so the link has to be shown. Inside
      // World App this is unused — the native transport resolves without it.
      setConnectorURI(request.connectorURI);

      const completion = await request.pollUntilCompletion({ timeout: 5 * 60 * 1000 });
      if (!completion.success) {
        setError(explain(completion.error));
        setPhase("error");
        return;
      }

      const res = await fetch("/api/identity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idkitResult: completion.result satisfies IDKitResult }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Lend could not confirm that check.");
        setPhase("error");
        return;
      }
      setPhase("done");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "The identity check could not be run.");
      setPhase("error");
    }
  }

  if (phase === "done") {
    return <p className="identity-note">Identity verified. This pool is open.</p>;
  }

  if (phase === "error") {
    return (
      <div className="identity-panel">
        <p className="error" role="alert">
          {error}
        </p>
        <button type="button" className="btn btn-quiet" onClick={() => setPhase("idle")}>
          Back
        </button>
      </div>
    );
  }

  if (phase === "idle") {
    return (
      <button
        type="button"
        className="btn btn-wide"
        onClick={() => (needsJurisdiction ? setPhase("choosing") : prepare(null))}
      >
        Verify my ID
      </button>
    );
  }

  if (phase === "choosing") {
    return (
      <div className="identity-panel">
        {/* Asked before anything is sent anywhere. Somebody outside the served list is told no here,
            without opening their document — which is the entire argument for attestations. */}
        <p className="identity-note">Where was your ID issued? This pool is only offered in some countries.</p>
        <div className="identity-countries">
          {SERVED_JURISDICTIONS.map((code) => (
            <button
              key={code}
              type="button"
              className="preview-chip"
              aria-pressed={country === code}
              onClick={() => setCountry(code)}
            >
              {JURISDICTION_NAMES[code] ?? code}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-wide" disabled={!country} onClick={() => prepare(country || null)}>
          Continue
        </button>
        <p className="identity-fine">
          Not listed? Lend is not licensed to offer this pool where your ID was issued. The Starter
          pool does not ask this.
        </p>
      </div>
    );
  }

  if (phase === "consenting" && challenge) {
    return (
      <div className="identity-panel">
        <p className="identity-note">{challenge.consent.summary}</p>
        <ul className="identity-shares">
          {challenge.consent.shares.map((line) => (
            <li key={line} className="shares">
              {line}
            </li>
          ))}
        </ul>
        {/* The half that integrations usually omit. A person cannot see the payload, so if the
            screen does not say what stays behind, they have no way to know. */}
        <p className="identity-fine">Not shared with Lend: {challenge.consent.withholds.join(", ")}.</p>
        <p className="identity-fine">
          You will need a passport, national eID, or mobile network ID already added to World App.
        </p>
        <button type="button" className="btn btn-wide" onClick={run}>
          Share these answers
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => setPhase("idle")}>
          Not now
        </button>
      </div>
    );
  }

  return (
    <div className="identity-panel">
      <p className="identity-note">Waiting for World App…</p>
      {connectorURI ? (
        <a className="btn btn-quiet" href={connectorURI} target="_blank" rel="noreferrer">
          Open World App
        </a>
      ) : null}
    </div>
  );
}

/**
 * IDKit error codes, translated into something a borrower can act on.
 *
 * The default is deliberately not "something went wrong": every one of these has a different next
 * step, and collapsing them wastes the one piece of information the user needs.
 */
function explain(code: string): string {
  switch (code) {
    case "user_rejected":
    case "cancelled":
      return "You cancelled the check. Nothing was shared.";
    case "credential_unavailable":
      return "World App has no ID document on this account. Add a passport or national eID in World App, then try again.";
    case "verification_rejected":
      return "World App declined to produce this proof.";
    case "identity_attributes_not_matched":
      return "Your ID does not match what this pool requires.";
    case "user_presence_failed":
      return "World App could not confirm you were present. Try again.";
    case "world_id_4_not_available":
      return "This version of World App does not support identity checks. Update World App and try again.";
    case "unknown_rp":
    case "inactive_rp":
      return "Lend is not registered for identity checks yet. This is our problem, not yours.";
    case "timeout":
      return "The check timed out. Nothing was shared.";
    case "max_verifications_reached":
      return "This ID has already been verified as many times as World allows for Lend.";
    default:
      return `The identity check failed (${code}).`;
  }
}
