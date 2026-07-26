"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Resolves a handle ("alice" or "alice.vouchme.eth") or a raw address against the live directory
 *  (`/api/identity/[idOrAddress]`, backed by real `Enrolled` events) and opens their profile. */
export function SearchBox() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSearching(true);
    setError(null);
    try {
      const attempts = q.startsWith("0x") ? [q] : [q, `${q.toLowerCase()}.vouchme.eth`];
      for (const attempt of attempts) {
        const res = await fetch(`/api/identity/${encodeURIComponent(attempt)}`);
        if (res.ok) {
          const body = await res.json();
          router.push(`/profile/${encodeURIComponent(body.data.address)}`);
          return;
        }
      }
      setError(`No VouchMe account found for "${q}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setSearching(false);
    }
  }

  return (
    <form onSubmit={(e) => void runSearch(e)} data-testid="search-box">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.9"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-graphite"
          >
            <circle cx="11" cy="11" r="6.5" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search a handle or address"
            className="field w-full"
            style={{ height: 52, paddingLeft: 44 }}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-testid="search-input"
          />
        </div>
        <button
          type="submit"
          disabled={searching || !query.trim()}
          className="btn btn-accent shrink-0"
          style={{ height: 52 }}
          data-testid="search-submit"
        >
          {searching ? "…" : "Search"}
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-2xs text-protest" data-testid="search-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
