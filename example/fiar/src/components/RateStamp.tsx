import { percent, usd } from "@/lib/format";
import type { Quote } from "@/lib/policy";

/**
 * The signature element.
 *
 * A circulation card gets a purple date stamp when the thing goes out. Fiar stamps the rate the
 * borrower's standing bought — so the abstract claim "reputation lowers your cost" arrives as a
 * physical mark on the card rather than as a sentence about a discount.
 *
 * Three impressions, because there are three honest outcomes: a discount, no discount, and an item
 * out of reach. A "0% off" stamp is the failure this avoids — it announces a discount and then
 * reports that there isn't one.
 */
export function RateStamp({ quote, animate = false }: { quote: Quote; animate?: boolean }) {
  const discount = 1 - quote.depositUsd / quote.depositAtFloorUsd;
  const cls = `stamp inline-block whitespace-nowrap px-3 py-1.5 text-center ${animate ? "stamp-animate" : ""}`;

  if (!quote.withinCeiling) {
    return (
      <div className={`${cls} stamp-strike`} role="status">
        <div className="font-typed text-2xs font-bold uppercase tracking-[0.2em]">Over your limit</div>
        <div className="font-typed text-xs">ceiling {usd(quote.ceilingUsd)}</div>
      </div>
    );
  }

  return (
    <div className={cls} role="status">
      <div className="font-typed text-2xs font-bold uppercase tracking-[0.2em]">
        {discount > 0 ? `Deposit ${percent(discount)} off` : "Full deposit"}
      </div>
      <div className="font-typed text-lg font-bold leading-tight">{usd(quote.depositUsd)}</div>
      <div className="font-typed text-2xs uppercase tracking-[0.16em]">{usd(quote.ratePerDayUsd)} a day</div>
    </div>
  );
}
