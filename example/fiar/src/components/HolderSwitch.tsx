"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { inWorldAppNow } from "@/lib/minikit";

/**
 * The browser preview control.
 *
 * Purely a development affordance: it swaps which public identity the catalogue is quoted for, and
 * proves nothing about who is holding the phone. It renders only outside World App, and disappears
 * entirely once a wallet is verified — a preview and a session must never look the same.
 *
 * Sign-in deliberately does NOT live here. It belongs on the button that spends money, so the act
 * of proving who you are sits next to the reason you are being asked. An earlier version signed in
 * silently on mount, which meant a wallet prompt appeared for someone who had only opened a
 * catalogue.
 */
export function HolderSwitch({ holder, previewNames }: { holder: string | null; previewNames: string[] }) {
  const router = useRouter();
  const [host, setHost] = useState<"unknown" | "world-app" | "browser">("unknown");

  useEffect(() => {
    setHost(inWorldAppNow() ? "world-app" : "browser");
  }, []);

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
