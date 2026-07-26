import Link from "next/link";
import { shortName, usd } from "@/lib/format";
import type { Closeness } from "@/lib/vouchme";
import type { Item, Quote } from "@/lib/policy";
import { RateStamp } from "./RateStamp";

/** "Alice vouches for both of you" is the line that makes a graph mean something to a person.
 *  A hop count is not; nobody has an intuition for hop counts. */
function connectionLine(closeness: Closeness, owner: string): string {
  if (closeness.sharedVouchers.length > 0) {
    const names = closeness.sharedVouchers.map(shortName);
    const listed = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
    return `${listed} ${names.length === 1 ? "vouches" : "vouch"} for you both`;
  }
  return `Directly connected to ${shortName(owner)}`;
}

export function ItemCard({ item, quote, closeness }: { item: Item; quote: Quote; closeness: Closeness | null }) {
  return (
    <Link
      href={`/item/${item.id}`}
      className="card block px-4 py-3 pl-9 transition-shadow hover:shadow-[3px_3px_0_rgb(35_38_31_/_0.14)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold leading-tight">{item.name}</h3>
          <p className="mt-0.5 font-typed text-2xs uppercase tracking-[0.14em] text-ink-soft">
            {shortName(item.owner)} · {item.neighbourhood}
          </p>
        </div>
        <div className="shrink-0">
          <RateStamp quote={quote} />
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-baseline gap-x-5 gap-y-1 border-t border-rule-card pt-2 font-typed text-xs">
        <span className="text-ink-soft">
          Worth <span className="text-ink">{usd(item.valueUsd)}</span>
        </span>
        {quote.withinCeiling && quote.depositSavedUsd > 0 ? (
          <span className="text-stamp">You keep {usd(quote.depositSavedUsd)}</span>
        ) : null}
        {quote.neighbourDiscountApplied && closeness ? (
          <span className="text-stamp">{connectionLine(closeness, item.owner)}</span>
        ) : null}
      </div>
    </Link>
  );
}
