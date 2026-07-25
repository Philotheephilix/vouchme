"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Resolves a handle ("alice" or "alice.aval.eth") or a raw address against the live directory
 *  (`/api/identity/[idOrAddress]`, backed by real `Enrolled` events) and opens their profile.
 *  Replaces the earlier hardcoded candidate lists — a real, if single-result, search. */
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
      const attempts = q.startsWith("0x") ? [q] : [q, `${q.toLowerCase()}.aval.eth`];
      for (const attempt of attempts) {
        const res = await fetch(`/api/identity/${encodeURIComponent(attempt)}`);
        if (res.ok) {
          const body = await res.json();
          router.push(`/profile/${encodeURIComponent(body.data.address)}`);
          return;
        }
      }
      setError(`No Aval account found for "${q}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setSearching(false);
    }
  }

  return (
    <form onSubmit={(e) => void runSearch(e)} data-testid="search-box">
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="search a handle or address"
          className="min-h-[44px] flex-1 border bg-transparent px-3 font-mono text-sm text-cream"
          style={{ borderColor: "var(--color-rule)" }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          data-testid="search-input"
        />
        <button
          type="submit"
          disabled={searching || !query.trim()}
          className="min-h-[44px] shrink-0 border px-3 font-mono text-2xs uppercase tracking-widest disabled:opacity-40"
          style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
          data-testid="search-submit"
        >
          {searching ? "…" : "Search"}
        </button>
      </div>
      {error ? (
        <p className="mt-2 text-2xs" style={{ color: "var(--color-protest)" }} data-testid="search-error">
          {error}
        </p>
      ) : null}
    </form>
  );
}
