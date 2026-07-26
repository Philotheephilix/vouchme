"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { inWorldAppNow } from "@/lib/minikit";

/**
 * A development affordance, and nothing more.
 *
 * It swaps which public identity the score card is drawn for. It proves nothing about who is
 * holding the phone, it never reaches `/api/claim`, and it renders only outside World App and only
 * while signed out — a preview and a session must never look the same.
 */
export function PreviewBar({ current, names }: { current: string | null; names: string[] }) {
  const router = useRouter();
  const [host, setHost] = useState<"unknown" | "world-app" | "browser">("unknown");

  useEffect(() => {
    setHost(inWorldAppNow() ? "world-app" : "browser");
  }, []);

  if (host !== "browser") return null;

  return (
    <div className="preview">
      <span className="label">Preview</span>
      {names.map((name) => (
        <button
          key={name}
          type="button"
          className="preview-chip"
          aria-pressed={current === name}
          onClick={() => router.replace(`?as=${encodeURIComponent(name)}`)}
        >
          {name.split(".")[0]}
        </button>
      ))}
      <button type="button" className="preview-chip" aria-pressed={current === null} onClick={() => router.replace("?")}>
        none
      </button>
    </div>
  );
}
