"use client";

import { useAuth } from "@/lib/session";
import { Bullseye, ConcentricRings, DotField, Slashes, Starburst, Sunburst } from "./Artifacts";
import { LoginHero } from "./illustrations";
import { Wordmark } from "./Wordmark";

/** The entire signed-out experience — the app's onboarding cover. No score, no dial, no endorsement
 *  rows: a coloured, unhurried welcome that ends in one action. Nothing else renders until someone
 *  is signed in. */
export function LoginScreen() {
  const { connecting, error, connect, clearError, isInWorldApp } = useAuth();
  // Outside World App no World ID is involved — the button opens whatever browser wallet is
  // installed. `isInWorldApp` is the host's own signal, so the label names the real action.
  const label = isInWorldApp ? "Sign in with World" : "Connect a wallet";

  return (
    <main
      data-testid="login-screen"
      className="relative mx-auto flex min-h-screen w-full max-w-[480px] flex-col overflow-hidden px-7"
      style={{ paddingBottom: "calc(44px + env(safe-area-inset-bottom))", paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* Poster layer — the one place the palette gets loud. A Swiss-poster scatter of blue marks
          drifting behind the copy: a big soft disc, a slow sunburst, rings, a spark and a dot field.
          All decorative, all aria-hidden, faint enough to keep the headline legible on top. */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 92,
          left: 8,
          width: 172,
          height: 172,
          borderRadius: "50%",
          background: "color-mix(in oklab, var(--color-accent) 30%, #fff)",
          filter: "blur(2px)",
          animation: "floaty 7s ease-in-out infinite",
        }}
      />
      <Sunburst
        size={260}
        rays={90}
        weight={1.1}
        className="artifact artifact-spin"
        style={{ position: "absolute", top: 46, right: -96, color: "color-mix(in oklab, var(--color-accent) 16%, transparent)" }}
      />
      <ConcentricRings
        size={150}
        rings={7}
        weight={1.4}
        className="artifact artifact-drift"
        style={{ position: "absolute", top: 300, left: -54, color: "color-mix(in oklab, var(--color-accent) 22%, transparent)" }}
      />
      <Bullseye
        size={54}
        className="artifact artifact-drift"
        style={{ position: "absolute", top: 214, right: 26, color: "var(--color-accent)", animationDelay: ".6s" }}
      />
      <Starburst
        size={40}
        points={8}
        className="artifact artifact-drift"
        style={{ position: "absolute", top: 150, left: 20, color: "var(--color-accent-dark)", animationDelay: "1.1s" }}
      />
      <DotField
        size={96}
        cols={8}
        className="artifact"
        style={{ position: "absolute", top: 366, right: 12, color: "color-mix(in oklab, var(--color-accent) 40%, transparent)" }}
      />
      <Slashes size={54} count={3} className="artifact" style={{ position: "absolute", top: 118, right: 30, color: "var(--color-accent)" }} />

      {/* the mark, top-left, riding above the blobs */}
      <div className="relative z-10 pt-14">
        <Wordmark size={19} />
      </div>

      {/* onboarding cover illustration — an abstract trust graph. Scales with the viewport so it
          never crowds the copy on a small iPhone: the SVG fills a width-capped box (globals.css
          .login-hero-svg forces width:100%), so 58vw on a 320px screen, 252px on anything roomy. */}
      <div className="relative z-10 mt-8 flex justify-center anim-rise-bounce" style={{ color: "var(--color-cream)" }}>
        <div style={{ width: "min(252px, 58vw)" }}>
          <LoginHero size={252} className="login-hero-svg" />
        </div>
      </div>

      <div className="relative z-10 mt-auto">
        {/* progress dots — one step, but they set the onboarding tone */}
        <div className="mb-6 flex gap-1.5 anim-rise-sm">
          <span style={{ width: 20, height: 5, borderRadius: 3, background: "var(--color-accent)" }} />
          <span style={{ width: 5, height: 5, borderRadius: 3, background: "var(--color-rule-strong)" }} />
          <span style={{ width: 5, height: 5, borderRadius: 3, background: "var(--color-rule-strong)" }} />
        </div>

        <h1
          className="text-cream anim-rise-bounce"
          style={{ fontSize: "clamp(30px, 9vw, 40px)", lineHeight: 1.05, fontWeight: 700, letterSpacing: "-.042em" }}
        >
          Proof of human
          <br />
          is a floor.
          <br />
          <span style={{ color: "var(--color-accent-dark)" }}>This is the ladder.</span>
        </h1>

        <button
          type="button"
          data-testid="login-signin"
          onClick={() => void connect()}
          disabled={connecting}
          className="btn btn-primary btn-block anim-rise-bounce mt-7"
          style={{ height: 62, borderRadius: 34, fontSize: 15, animationDelay: ".12s" }}
        >
          {connecting ? "Connecting…" : label}
          {!connecting ? (
            <svg width="17" height="17" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M3 9h11M10 4.5 14.5 9 10 13.5" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : null}
        </button>
        {error ? (
          <button type="button" onClick={clearError} className="mt-4 max-w-xs text-left text-2xs leading-snug text-protest">
            {error}
          </button>
        ) : null}
      </div>
    </main>
  );
}
