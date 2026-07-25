/**
 * app/src/lib/session.tsx
 *
 * The missing foundation: who is using this app right now. `connect()` tries MiniKit's native
 * SIWE (`walletAuth`) when running inside World App, and falls back to a plain EIP-1193
 * `eth_requestAccounts` prompt everywhere else (see src/lib/wallet.ts — no wagmi, no RainbowKit).
 *
 * Persisted as a plain (non-httpOnly) cookie, `aval_addr`, so a refresh doesn't lose it AND
 * server components (Home) can read it via `next/headers` `cookies()` to render the signed-in
 * user's own data instead of the `ME_ADDRESS` demo fallback. The address is a public fact once a
 * wallet connects, so a readable cookie carries no secret.
 */

"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { getAddress, type Address } from "viem";
import { MiniKit } from "@worldcoin/minikit-js";
import { getAppId } from "./worldchain";
import { getAuthorizedAccount, hasInjectedProvider, requestAccount, WalletError } from "./wallet";

const COOKIE_NAME = "aval_addr";
const COOKIE_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : null;
}

function writeCookie(name: string, value: string | null): void {
  if (typeof document === "undefined") return;
  if (value === null) {
    document.cookie = `${name}=; path=/; max-age=0`;
  } else {
    document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${COOKIE_MAX_AGE_S}; samesite=lax`;
  }
}

function randomNonce(): string {
  // MiniKit requires an alphanumeric nonce of at least 8 characters.
  return crypto.randomUUID().replace(/-/g, "").slice(0, 16);
}

export type WalletVia = "minikit" | "injected";

interface AuthState {
  address: Address | null;
  via: WalletVia | null;
  connecting: boolean;
  error: string | null;
  isInWorldApp: boolean;
}

interface AuthContextValue extends AuthState {
  connect: () => Promise<void>;
  disconnect: () => void;
  clearError: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

let miniKitInstalled = false;

export function AuthProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<AuthState>({
    address: null,
    via: null,
    connecting: false,
    error: null,
    isInWorldApp: false,
  });

  // Install MiniKit once, client-side only, then restore whatever session we can find without
  // prompting the user (a cookie from a previous visit; a silently-authorized injected wallet).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!miniKitInstalled) {
        try {
          MiniKit.install(getAppId());
        } catch {
          // Config error surfaces later, on an explicit connect() attempt.
        }
        miniKitInstalled = true;
      }
      const inWorldApp = MiniKit.isInstalled();

      const cookieAddr = readCookie(COOKIE_NAME);
      if (inWorldApp && MiniKit.user?.walletAddress) {
        const addr = getAddress(MiniKit.user.walletAddress);
        if (!cancelled) setState((s) => ({ ...s, address: addr, via: "minikit", isInWorldApp: true }));
        writeCookie(COOKIE_NAME, addr);
        return;
      }
      if (cookieAddr) {
        // Trust the cookie immediately (avoids a signed-out flash); reconcile in the background.
        if (!cancelled) setState((s) => ({ ...s, address: getAddress(cookieAddr), via: "injected", isInWorldApp: inWorldApp }));
        if (hasInjectedProvider()) {
          const authorized = await getAuthorizedAccount();
          if (!cancelled && (!authorized || authorized.toLowerCase() !== cookieAddr.toLowerCase())) {
            // The wallet no longer authorizes this address (switched account, revoked, or a
            // different device) — don't keep claiming a session we can't back up.
            writeCookie(COOKIE_NAME, null);
            setState((s) => ({ ...s, address: null, via: null }));
          }
        }
      } else if (!cancelled) {
        setState((s) => ({ ...s, isInWorldApp: inWorldApp }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, connecting: true, error: null }));
    try {
      if (MiniKit.isInstalled()) {
        const result = await MiniKit.walletAuth({ nonce: randomNonce(), statement: "Sign in to Aval." });
        const addr = getAddress(result.data.address);
        writeCookie(COOKIE_NAME, addr);
        setState((s) => ({ ...s, address: addr, via: "minikit", connecting: false, isInWorldApp: true }));
        return;
      }
      if (hasInjectedProvider()) {
        const addr = await requestAccount();
        writeCookie(COOKIE_NAME, addr);
        setState((s) => ({ ...s, address: addr, via: "injected", connecting: false }));
        return;
      }
      throw new WalletError(
        "no_wallet",
        "No wallet available. Open this app inside World App, or install a browser wallet (e.g. MetaMask) to connect one here.",
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setState((s) => ({ ...s, connecting: false, error: message }));
    }
  }, []);

  const disconnect = useCallback(() => {
    writeCookie(COOKIE_NAME, null);
    setState((s) => ({ ...s, address: null, via: null, error: null }));
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
