"use client";

import { MiniKit } from "@worldcoin/minikit-js";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Who is holding the card.
 *
 * Inside World App this is not a question: `MiniKit.walletAuth()` gives Fiar the user's address,
 * and that address is the only thing VouchMe needs — no API key, no consent screen, no account
 * linking. That is the entire "authentication" story of this integration.
 *
 * Outside World App there is no wallet to ask, so it falls back to a `?as=` parameter. That is a
 * preview affordance for running Fiar in a desktop browser, and it is deliberately visible rather
 * than hidden, so nobody mistakes a previewed card for a signed-in one.
 */

/** `window.WorldApp` is injected by the host webview and is the ground truth for "running inside
 *  World App". `MiniKit.isInstalled()` reads a per-module-copy flag that can answer false even
 *  after a successful install, so it is used only as a secondary signal. */
function inWorldApp(): boolean {
  if (typeof window === "undefined") return false;
  return "WorldApp" in window || MiniKit.isInstalled();
}

export function HolderSwitch({ holder, previewNames }: { holder: string | null; previewNames: string[] }) {
  const router = useRouter();
  const params = useSearchParams();
  const [host, setHost] = useState<"unknown" | "world-app" | "browser">("unknown");

  useEffect(() => {
    if (!inWorldApp()) {
      setHost("browser");
      return;
    }
    setHost("world-app");
    // Already previewing a specific name — respect that over the wallet, so a demo can pin a card.
    if (params.get("as")) return;

    let cancelled = false;
    void (async () => {
      try {
        const nonce = crypto.randomUUID().replace(/-/g, "");
        const result = await MiniKit.walletAuth({
          nonce,
          statement: "Show your VouchMe standing so Fiar can price your deposit.",
        });
        const address: unknown = result?.data?.address;
        if (cancelled || typeof address !== "string") return;
        // Fiar reads public data only, so an unverified address here can at worst show somebody
        // else's public discount to a browser that asked for it. A mini app that ACTS on the
        // address — takes the deposit, hands over the drill — must POST `result.data.signature`
        // and `result.data.message` to its own server and verify the SIWE signature against a
        // server-issued nonce first.
        router.replace(`?as=${encodeURIComponent(address)}`);
      } catch {
        // The user dismissed the wallet sheet, or the host refused. Leave them on the default
        // card rather than blocking the catalogue behind a sign-in they did not ask for.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params, router]);

  if (host !== "browser") return null;

  return (
    <div className="flex flex-wrap items-center gap-2 border border-dashed border-pocket px-3 py-2">
      <span className="font-typed text-2xs uppercase tracking-[0.2em] text-ink-soft">Preview as</span>
      {previewNames.map((name) => {
        const active = holder === name;
        return (
          <button
            key={name}
            type="button"
            onClick={() => router.replace(`?as=${encodeURIComponent(name)}`)}
            className={`border px-2 py-0.5 font-typed text-2xs transition-colors ${
              active
                ? "border-stamp bg-stamp text-card"
                : "border-pocket text-ink-soft hover:border-stamp hover:text-stamp"
            }`}
          >
            {name.split(".")[0]}
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => router.replace("?as=")}
        className="border border-pocket px-2 py-0.5 font-typed text-2xs text-ink-soft transition-colors hover:border-stamp hover:text-stamp"
      >
        nobody
      </button>
    </div>
  );
}
