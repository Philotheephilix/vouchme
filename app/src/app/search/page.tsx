import { Header } from "@/components/Header";
import { SearchBox } from "@/components/SearchBox";

/** The three input shapes the resolver accepts (SearchBox tries the bare label, then the
 *  `.vouchme.eth` suffix, then a raw address) — shown so the field is never a blank guess. */
const FORMATS: { label: string; example: string; note: string }[] = [
  { label: "Handle", example: "alice", note: "just the label" },
  { label: "VouchMe name", example: "alice.vouchme.eth", note: "the full ENS name" },
  { label: "Wallet address", example: "0x1a2b…c3d4", note: "any enrolled address" },
];

export default function SearchPage() {
  return (
    <div className="pb-8">
      <Header eyebrow="SEARCH" title="Find a member" subtitle="Look up any human by handle or address." />

      <section className="px-4 pt-4">
        <p className="mb-4 text-sm leading-relaxed text-graphite">
          Find an enrolled member by handle — the bare label or the full{" "}
          <span className="font-mono text-cream">&lt;handle&gt;.vouchme.eth</span> — or by wallet address.
        </p>

        <SearchBox />

        {/* Accepted-format reference: one container, a definition row per input shape — not three
            look-alike cards. Fills the page with orientation the searcher actually uses. */}
        <div className="card mt-6 overflow-hidden">
          <div className="eyebrow border-b px-4 pt-4 pb-3" style={{ borderColor: "var(--color-rule-strong)" }}>
            Accepted formats
          </div>
          <dl>
            {FORMATS.map((f, i) => (
              <div
                key={f.label}
                className="flex items-center justify-between gap-3 px-4 py-3"
                style={i > 0 ? { borderTop: "1px solid var(--color-rule)" } : undefined}
              >
                <dt>
                  <div className="text-sm text-cream">{f.label}</div>
                  <div className="text-2xs text-graphite">{f.note}</div>
                </dt>
                <dd className="truncate-mono max-w-[52%] font-mono text-2xs text-graphite">{f.example}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>
    </div>
  );
}
