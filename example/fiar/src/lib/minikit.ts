"use client";

import { MiniKit } from "@worldcoin/minikit-js";

/**
 * Getting MiniKit actually installed, which is not the one-liner it looks like.
 *
 * Fiar originally imported MiniKit and called `walletAuth()` directly. Inside World App that fails
 * with "wallet-auth is unavailable: World App version does not support this command" — not because
 * the version is old, but because `install()` was never called, so MiniKit never completed the host
 * handshake that tells it which commands exist. Every command then reports unsupported.
 *
 * Two further traps, both already learned the hard way in the VouchMe app
 * (app/src/lib/session.tsx) and mirrored here so an integrator copying this file gets the working
 * version rather than the obvious one:
 *
 *  1. `install()` returns failure if `window.WorldApp` is not there yet, and leaves MiniKit
 *     permanently not-ready. The host injects `window.WorldApp` into the webview and is under no
 *     obligation to have done so by the time React mounts, so the call has to be retried.
 *
 *  2. `MiniKit.isInstalled()` reads a flag on one class object. minikit-js sets
 *     `window.MiniKit = this` on success and delegates through `getActiveMiniKit()`, so with more
 *     than one copy of the module in a bundle the imported `MiniKit` may not be the live instance —
 *     its `isInstalled()` answers false forever and commands go to an object that was never
 *     initialised. Commands must be issued through whichever object is actually live.
 */

/** The one signal that cannot be falsified by this app's own bookkeeping: the host injected it. */
export function inWorldAppNow(): boolean {
  return typeof window !== "undefined" && Boolean((window as { WorldApp?: unknown }).WorldApp);
}

/** The MiniKit object holding the live connection, which may not be the imported one. */
export function activeMiniKit(): typeof MiniKit {
  if (typeof window !== "undefined") {
    const candidate = (window as { MiniKit?: unknown }).MiniKit as typeof MiniKit | undefined;
    if (candidate && typeof (candidate as { trigger?: unknown }).trigger === "function") return candidate;
  }
  return MiniKit;
}

export function getAppId(): string {
  return process.env.NEXT_PUBLIC_APP_ID ?? "";
}

let installed = false;

/** Install, retrying while `window.WorldApp` is still missing. Costs nothing when it is already
 *  there — the first attempt wins — and recovers the case where it is not. */
export async function ensureMiniKit(timeoutMs = 5_000): Promise<{ ok: boolean; detail: string }> {
  if (installed && activeMiniKit().isInstalled()) return { ok: true, detail: "already installed" };
  if (typeof window === "undefined") return { ok: false, detail: "no window (server)" };

  const appId = getAppId();
  if (!appId.startsWith("app_")) {
    return { ok: false, detail: "NEXT_PUBLIC_APP_ID is not set to a World Developer Portal app id" };
  }

  const deadline = Date.now() + timeoutMs;
  let lastDetail = "not attempted";
  for (;;) {
    try {
      const result = MiniKit.install(appId) as { success?: boolean; errorCode?: string } | undefined;
      if (activeMiniKit().isInstalled()) {
        installed = true;
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
