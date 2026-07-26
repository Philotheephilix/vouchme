/**
 * app/src/lib/session.tsx
 *
 * Who is using this app right now. `connect()` tries MiniKit's native SIWE (`walletAuth`) when
 * running inside World App, and falls back to a plain EIP-1193 `personal_sign` prompt everywhere
 * else (see src/lib/wallet.ts — no wagmi, no RainbowKit).
 *
 * Both paths go through a server-issued nonce -> real signature -> `/api/auth/verify` round trip
 * (src/lib/authClient.ts, src/app/api/auth/*, src/lib/authSession.ts) before any session exists.
 * On success the server sets two cookies via `Set-Cookie`:
 *   - `vouchme_session` (httpOnly, HMAC-bound to the verified address) — the only cookie any server
 *     page (Home, Reports, Profile, this gate) trusts for authorization.
 *   - `vouchme_addr` (plain) — kept only so this module can read it back here for a fast,
 *     non-blocking UI restore on load, and because src/app/agents/ still reads it directly. It is
 *     display-only; nothing security-relevant reads it.
 */

"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getAddress, type Address } from "viem";
import { MiniKit } from "@worldcoin/minikit-js";
import { getAppId } from "./worldchain";
import { getAuthorizedAccount, hasInjectedProvider, personalSign, requestAccount, WalletError } from "./wallet";
import { fetchNonce, fetchVerifiedSession, signOutSession, verifySignIn } from "./authClient";
import { buildSignInMessage } from "./signInMessage";

const COOKIE_NAME = "vouchme_addr";
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days — display-only mirror; must match authSession.ts's session TTL.

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

/** Writes only the plain, display-only `vouchme_addr` mirror — never the verified session, which is
 *  httpOnly and can only ever be set by the server (src/lib/authSession.ts) after a real signature
 *  checks out. See this file's doc comment. */
function writeCookie(name: string, value: string | null): void {
  if (typeof document === "undefined") return;
  if (value === null) {
    document.cookie = `${name}=; path=/; max-age=0`;
  } else {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE_S}; samesite=lax`;
  }
}

export type WalletVia = "minikit" | "injected";

interface AuthState {
  address: Address | null;
  via: WalletVia | null;
  connecting: boolean;
  error: string | null;
  isInWorldApp: boolean;
  /** True from first mount until the one-shot session restore below has settled. Distinguishes
   *  "we don't know yet who this is" from "nobody is signed in", so the gate can hold a neutral
   *  loading screen instead of flashing the sign-in wall on every fresh page load / hard nav. */
  restoring: boolean;
}

interface AuthContextValue extends AuthState {
  connect: () => Promise<void>;
  disconnect: () => void;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Latched only on a SUCCESSFUL install, never on a failed attempt — see `ensureMiniKit`. */
let miniKitInstalled = false;

/** True when the page is running inside World App's webview.
 *
 *  `window.WorldApp` is injected by the host itself, so it is the one signal that cannot be
 *  falsified by this app's own module bookkeeping. `MiniKit.isInstalled()` can report false in a
 *  perfectly healthy World App session (see the comment in `connect`), so it must never be what
 *  decides whether to take the World App path. */
export function inWorldAppNow(): boolean {
  return typeof window !== "undefined" && Boolean((window as { WorldApp?: unknown }).WorldApp);
}

/** The MiniKit object that actually holds the live connection.
 *
 *  minikit-js sets `window.MiniKit = this` on a successful install and treats that as the active
 *  instance (`getActiveMiniKit()` checks for a callable `trigger`). With more than one copy of the
 *  module in the bundle, the imported `MiniKit` may not be that instance — commands must go to the
 *  live one or they are sent from an object that was never initialised. */
export function activeMiniKit(): typeof MiniKit {
  if (typeof window !== "undefined") {
    const candidate = (window as { MiniKit?: unknown }).MiniKit as typeof MiniKit | undefined;
    if (candidate && typeof (candidate as { trigger?: unknown }).trigger === "function") return candidate;
  }
  return MiniKit;
}

/**
 * Install MiniKit, retrying while `window.WorldApp` is still missing.
 *
 * Reading minikit-js 2.0.3's own source (`build/chunk-7RB4UJBW.js`):
 *
 *     install(appId) {
 *       ...
 *       if (!window.WorldApp) return { success: false, errorCode: "outside_of_worldapp", ... };
 *       window.MiniKit = this; this.sendInit(); this._isReady = true;
 *     }
 *     isInstalled() { return this._isReady && Boolean(window.MiniKit); }
 *
 * So a call made before World App has injected `window.WorldApp` fails and leaves `_isReady`
 * false — permanently, unless something retries, and then `isInstalled()` answers false for the
 * whole session.
 *
 * `window.WorldApp` is injected by the host webview and is not guaranteed to exist by the time
 * React mounts. Polling briefly costs nothing when it's already there (first attempt wins) and
 * recovers the case where it isn't.
 */
async function ensureMiniKit(appId: string, timeoutMs = 5_000): Promise<{ ok: boolean; detail: string }> {
  if (miniKitInstalled && activeMiniKit().isInstalled()) return { ok: true, detail: "already installed" };
  if (typeof window === "undefined") return { ok: false, detail: "no window (server)" };

  const deadline = Date.now() + timeoutMs;
  let lastDetail = "not attempted";
  for (;;) {
    try {
      const result = MiniKit.install(appId) as { success?: boolean; errorCode?: string } | undefined;
      if (activeMiniKit().isInstalled()) {
        miniKitInstalled = true;
        return { ok: true, detail: "installed" };
      }
      lastDetail = result?.errorCode ?? "install returned without becoming ready";
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
    }
    if (Date.now() >= deadline) return { ok: false, detail: lastDetail };
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  // Local browser-preview bypass (NEXT_PUBLIC_PREVIEW=1 in the gitignored .env.local): seed the
  // signed-in address with the fixture demo identity so the header, bottom nav and vouch/enroll
  // gating render as a real member without a wallet. Never active in a normal build.
  const previewAddress =
    process.env.NEXT_PUBLIC_PREVIEW === "1" ? (process.env.NEXT_PUBLIC_PREVIEW_ADDRESS as Address | undefined) ?? null : null;
  const [state, setState] = useState<AuthState>({
    address: previewAddress,
    via: null,
    connecting: false,
    error: null,
    isInWorldApp: false,
    // Preview seeds a fixture identity and skips the restore effect below, so nothing will ever flip
    // this — start settled there. Everywhere else the restore round trip is still pending on mount.
    restoring: process.env.NEXT_PUBLIC_PREVIEW !== "1",
  });

  // Install MiniKit once, client-side only, then restore whatever session we can find without
  // prompting the user (a cookie from a previous visit; a silently-authorized injected wallet).
  // This only ever sets local UI state from the plain `vouchme_addr` mirror — it cannot manufacture a
  // verified `vouchme_session`, so a page whose data depends on one (Home, Reports, Profile) won't
  // render anything for an address restored this way until `connect()` actually runs the verified
  // round trip. That's a deliberate fail-closed gap, not a bypass of it.
  useEffect(() => {
    // Preview bypass: keep the seeded fixture identity; don't run the real session restore, which
    // would find no cookie and reset the address to null.
    if (process.env.NEXT_PUBLIC_PREVIEW === "1") return;
    let cancelled = false;
    (async () => {
      try {
        await ensureMiniKit(getAppId());
      } catch {
        // Config error (missing NEXT_PUBLIC_APP_ID) surfaces on an explicit connect() attempt.
      }
      if (cancelled) return;
      // Ground truth from the host, not from module state — see `inWorldAppNow`.
      const inWorldApp = inWorldAppNow();

      // THE source of truth: what the server will actually authorize, read from the httpOnly
      // session cookie the client cannot see or forge. `MiniKit.user.walletAddress` and the plain
      // `vouchme_addr` cookie are client-side facts that say nothing about whether a verified
      // `vouchme_session` exists — claiming a session the server won't honour is worse than showing a
      // Sign in button, because the Sign in button is the thing that fixes it.
      const verified = await fetchVerifiedSession();
      if (cancelled) return;
      if (verified) {
        setState((s) => ({ ...s, address: verified, via: inWorldApp ? "minikit" : "injected", isInWorldApp: inWorldApp, restoring: false }));
        writeCookie(COOKIE_NAME, verified);
        return;
      }

      const cookieAddr = readCookie(COOKIE_NAME);
      if (inWorldApp && MiniKit.user?.walletAddress) {
        // Inside World App with a wallet, but no verified session yet. Report signed OUT and let
        // `connect()` run the nonce -> signature -> verify round trip: the wallet being present is
        // not consent, and it is not proof.
        if (!cancelled) setState((s) => ({ ...s, address: null, via: null, isInWorldApp: true, restoring: false }));
        writeCookie(COOKIE_NAME, null);
        return;
      }
      if (cookieAddr) {
        // A stale `vouchme_addr` mirror with no verified session behind it — e.g. an expired session.
        // Clear it rather than render a signed-in shell the server will refuse to fill.
        writeCookie(COOKIE_NAME, null);
        if (!cancelled) setState((s) => ({ ...s, address: null, via: null, isInWorldApp: inWorldApp, restoring: false }));
      } else if (!cancelled) {
        setState((s) => ({ ...s, isInWorldApp: inWorldApp, restoring: false }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      // Retry the install here too, not just on mount. The mount attempt can lose the race with
      // World App injecting `window.WorldApp`, and a user tapping Connect is the strongest signal
      // yet that the host is ready — so this is the moment worth re-checking, rather than
      // answering off a stale result from page load.
      let miniKitDetail = "not attempted";
      try {
        miniKitDetail = (await ensureMiniKit(getAppId())).detail;
      } catch (err) {
        miniKitDetail = err instanceof Error ? err.message : String(err);
      }
      // `window.WorldApp` — injected by the host webview — is the ground truth for "this page is
      // running inside World App". `MiniKit.isInstalled()` is NOT: it reads `this._isReady`, a
      // per-class-object flag, and minikit-js's own `install()` begins with
      //
      //     const active = this.getActiveMiniKit();
      //     if (active !== this) return active.install(appId);
      //
      // so when `window.MiniKit` is a *different* copy of the module (this app imports MiniKit in
      // five files and also mounts `MiniKitProvider` from a second entry point), install is
      // delegated to that copy and OUR imported class's `_isReady` never becomes true. Its
      // `isInstalled()` then answers false forever, no matter how many times install succeeds.
      //
      // So: decide the branch on `window.WorldApp`, and issue commands through whichever MiniKit
      // object is actually live.
      if (inWorldAppNow()) {
        const MK = activeMiniKit();
        // A server-issued nonce, not a locally-generated one, so /api/auth/verify can hold this
        // signature to a specific, single-use, expiring challenge instead of trusting whatever
        // nonce the client claims it used.
        const nonce = await fetchNonce();
        const result = await MK.walletAuth({ nonce: nonce.nonce, statement: "Sign in to VouchMe." });
        const addr = getAddress(result.data.address);
        const verified = await verifySignIn({
          address: addr,
          signature: result.data.signature,
          message: result.data.message,
          nonce,
        });
        // The server has already set the verified `vouchme_session` cookie (httpOnly) via
        // Set-Cookie; only the display-only mirror is this module's job.
        writeCookie(COOKIE_NAME, verified.address);
        setState((s) => ({ ...s, address: getAddress(verified.address), via: "minikit", connecting: false, isInWorldApp: true }));
        return;
      }
      if (hasInjectedProvider()) {
        const addr = await requestAccount();
        const nonce = await fetchNonce();
        const message = buildSignInMessage(addr, nonce.nonce, nonce.issuedAt, nonce.expiresAt);
        const signature = await personalSign(message, addr);
        // No `message` field here — /api/auth/verify rebuilds the exact expected message itself
        // for this path, so nothing the client sends can widen what was actually signed.
        const verified = await verifySignIn({ address: addr, signature, nonce });
        writeCookie(COOKIE_NAME, verified.address);
        setState((s) => ({ ...s, address: getAddress(verified.address), via: "injected", connecting: false }));
        return;
      }
      // The message asserts no cause, because the code has no evidence for one — it reports the
      // four facts that actually separate the possibilities: `WorldApp` absent means the host
      // never injected it; present-but-MiniKit-false means install ran too early or failed, and
      // `install` carries the reason.
      const worldAppGlobal = typeof window !== "undefined" && "WorldApp" in window;
      throw new WalletError(
        "no_wallet",
        "No wallet available yet. If you're inside World App, close and reopen the app and try " +
          "again. Outside World App, a browser wallet (e.g. MetaMask) works here. " +
          `Diagnostics — WorldApp:${worldAppGlobal ? "yes" : "no"} ` +
          `MiniKit:${activeMiniKit().isInstalled() ? "yes" : "no"} ` +
          `injected:${hasInjectedProvider() ? "yes" : "no"} ` +
          `install:${miniKitDetail}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, connecting: false, error: message }));
    }
  }, []);

  const disconnect = useCallback(() => {
    writeCookie(COOKIE_NAME, null);
    setState((s) => ({ ...s, address: null, via: null, error: null }));
    void signOutSession();
  }, []);

  const clearError = useCallback(() => setState((s) => ({ ...s, error: null })), []);

  const value = useMemo<AuthContextValue>(
    () => ({ ...state, connect, disconnect, clearError }),
    [state, connect, disconnect, clearError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth() must be used within <AuthProvider>.");
  return ctx;
}
