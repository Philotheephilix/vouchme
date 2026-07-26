import { Suspense } from "react";
import { CATALOG } from "@/lib/catalog";
import { quote } from "@/lib/policy";
import { resolveHolder } from "@/lib/holder";
import { readProximity, readStanding } from "@/lib/vouchme";
import { HolderCard } from "@/components/HolderCard";
import { HolderSwitch } from "@/components/HolderSwitch";
import { ItemCard } from "@/components/ItemCard";
import { Provenance } from "@/components/Provenance";

// Standing is revocable in one tap and takes effect on the next read, so a cached page is a page
// quoting a price that may no longer be earned.
export const dynamic = "force-dynamic";

const PREVIEW_NAMES = ["carol.alice.vouchme.eth", "alice.vouchme.eth", "anchor1.vouchme.eth", "ring1.eth"];

export default async function CataloguePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id: holder, verified } = await resolveHolder((await searchParams).as);
  const [{ standing, unavailable }, hops] = await Promise.all([
    readStanding(holder),
    readProximity(holder, CATALOG),
  ]);

  // Nobody borrows their own drill. Matched on both identifiers because the holder arrives as an
  // address inside World App and as an ENS name in preview.
  const mine = new Set([holder?.toLowerCase(), standing?.address.toLowerCase(), standing?.ensName.toLowerCase()]);
  const quoted = CATALOG.filter((item) => !mine.has(item.owner.toLowerCase())).map((item) => {
    const closeness = hops.get(item.id) ?? null;
    return { item, closeness, quote: quote({ item, standing, hopsToOwner: closeness?.hops ?? null }) };
  });
  const available = quoted.filter((row) => row.quote.withinCeiling);
  const overLimit = quoted.filter((row) => !row.quote.withinCeiling);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-4 py-6 pb-16">
      <header>
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-2xl font-extrabold uppercase leading-none tracking-[-0.02em]">Fiar</h1>
          <span className="font-typed text-2xs uppercase tracking-[0.2em] text-ink-soft">Lending library</span>
        </div>
        <p className="mt-2 max-w-prose text-sm leading-relaxed text-ink-soft">
          Borrow things from people nearby. Your deposit is set by who vouches for you, not by what you can afford
          to leave behind — so the less you have, the more this is worth.
        </p>
      </header>

      {verified ? null : (
        <Suspense fallback={null}>
          <HolderSwitch holder={holder} previewNames={PREVIEW_NAMES} />
        </Suspense>
      )}

      <HolderCard holder={holder} standing={standing} unavailable={unavailable} verified={verified} />

      <section className="flex flex-col gap-3" aria-label="Available to borrow">
        <h2 className="font-typed text-2xs uppercase tracking-[0.24em] text-ink-soft">
          On the shelf — {available.length} of {quoted.length}
        </h2>
        {available.map(({ item, quote: q, closeness }) => (
          <ItemCard key={item.id} item={item} quote={q} closeness={closeness} />
        ))}
      </section>

      {overLimit.length > 0 ? (
        <section className="flex flex-col gap-3" aria-label="Above your limit">
          <h2 className="font-typed text-2xs uppercase tracking-[0.24em] text-ink-soft">
            Above your limit — one more rung
          </h2>
          {overLimit.map(({ item, quote: q, closeness }) => (
            <ItemCard key={item.id} item={item} quote={q} closeness={closeness} />
          ))}
        </section>
      ) : null}

      <footer className="border-t border-rule pt-3">
        <Provenance meta={standing?.meta ?? null} />
        <p className="mt-1 font-typed text-2xs text-ink-soft">
          Fiar reads VouchMe. It cannot vouch for anyone, and no amount of borrowing raises a score.
        </p>
      </footer>
    </main>
  );
}
