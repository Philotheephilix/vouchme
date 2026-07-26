import Link from "next/link";
import { notFound } from "next/navigation";
import { findItem } from "@/lib/catalog";
import { percent, points, shortName, usd } from "@/lib/format";
import { ceilingFor, ladder, POLICY, quote, tierThatReaches, youRung } from "@/lib/policy";
import { resolveHolder } from "@/lib/holder";
import { readProximity, readStanding } from "@/lib/vouchme";
import { BorrowButton } from "@/components/BorrowButton";
import { Ladder } from "@/components/Ladder";
import { Provenance } from "@/components/Provenance";
import { RateStamp } from "@/components/RateStamp";

export const dynamic = "force-dynamic";

export default async function ItemPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const item = findItem((await params).id);
  if (!item) notFound();

  const { id: holder, verified } = await resolveHolder((await searchParams).as);
  const [{ standing }, hops] = await Promise.all([readStanding(holder), readProximity(holder, [item])]);
  const closeness = hops.get(item.id) ?? null;
  const q = quote({ item, standing, hopsToOwner: closeness?.hops ?? null });
  const rungs = ladder(item);
  const reachedAt = tierThatReaches(item.valueUsd);
  const backHref = verified ? "/" : holder ? `/?as=${encodeURIComponent(holder)}` : "/?as=";

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-5 px-4 py-6 pb-16">
      <Link href={backHref} className="font-typed text-2xs uppercase tracking-[0.2em] text-ink-soft hover:text-stamp">
        ← Back to the shelf
      </Link>

      <article className="card px-4 py-4 pl-9">
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold leading-tight">{item.name}</h1>
            <p className="mt-1 font-typed text-2xs uppercase tracking-[0.16em] text-ink-soft">
              {shortName(item.owner)} · {item.neighbourhood} · worth {usd(item.valueUsd)}
            </p>
          </div>
          <RateStamp quote={q} animate />
        </header>

        <p className="mt-4 max-w-prose border-l-2 border-pocket pl-3 text-sm italic leading-relaxed text-ink-soft">
          “{item.note}”
        </p>
      </article>

      <section className="card px-4 py-4 pl-9" aria-label="What you pay">
        <h2 className="font-typed text-2xs uppercase tracking-[0.24em] text-ink-soft">What you pay</h2>

        {q.withinCeiling ? (
          <>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
              <div>
                <dt className="font-typed text-2xs uppercase tracking-[0.16em] text-ink-soft">Deposit</dt>
                <dd className="font-typed text-xl font-bold leading-tight">{usd(q.depositUsd)}</dd>
                <dd className="font-typed text-2xs text-ink-soft line-through">{usd(q.depositAtFloorUsd)}</dd>
              </div>
              <div>
                <dt className="font-typed text-2xs uppercase tracking-[0.16em] text-ink-soft">Per day</dt>
                <dd className="font-typed text-xl font-bold leading-tight">{usd(q.ratePerDayUsd)}</dd>
                <dd className="font-typed text-2xs text-ink-soft line-through">{usd(q.ratePerDayAtFloorUsd)}</dd>
              </div>
            </dl>

            <ul className="mt-4 flex flex-col gap-1.5 border-t border-rule-card pt-3 text-sm">
              <li className="flex justify-between gap-4">
                <span className="text-ink-soft">Standing</span>
                <span className="font-typed">
                  {standing ? `${points(standing.score)} · ${percent(q.karmaFactor)} of the scale` : "none"}
                </span>
              </li>
              {q.neighbourDiscountApplied ? (
                <li className="flex justify-between gap-4 text-stamp">
                  <span>
                    {closeness && closeness.sharedVouchers.length > 0
                      ? `${closeness.sharedVouchers.map(shortName).join(" and ")} ${
                          closeness.sharedVouchers.length === 1 ? "vouches" : "vouch"
                        } for both of you`
                      : // One of you vouched for the other; the proximity read establishes the
                        // edge without reporting which way it points, so the copy must not claim.
                        `You and ${shortName(item.owner)} are directly connected`}
                  </span>
                  <span className="whitespace-nowrap font-typed">−{percent(POLICY.neighbourDepositDiscount)} deposit</span>
                </li>
              ) : (
                <li className="flex justify-between gap-4">
                  <span className="text-ink-soft">
                    Nobody vouches for both you and {shortName(item.owner)}
                  </span>
                  <span className="whitespace-nowrap font-typed text-ink-soft">no discount</span>
                </li>
              )}
              {q.credentialDiscounted ? (
                <li className="flex justify-between gap-4">
                  <span className="text-limit">Credential lapsed into its grace window</span>
                  <span className="whitespace-nowrap font-typed text-limit">karma counted at half</span>
                </li>
              ) : null}
              <li className="flex justify-between gap-4 border-t border-rule-card pt-2">
                <span className="font-medium">You keep</span>
                <span className="font-typed font-bold">{usd(q.depositSavedUsd)}</span>
              </li>
            </ul>

            <BorrowButton itemId={item.id} depositUsd={q.depositUsd} signedIn={verified} />
          </>
        ) : (
          <div className="mt-3">
            <p className="max-w-prose text-sm leading-relaxed">
              This is worth <span className="font-typed">{usd(item.valueUsd)}</span>. At{" "}
              {standing ? `Tier ${standing.tier}` : "no standing"} Fiar lends up to{" "}
              <span className="font-typed">{usd(q.ceilingUsd)}</span>.
              {reachedAt === null
                ? " Nothing Fiar lends reaches it."
                : ` Tier ${reachedAt} lends up to ${usd(ceilingFor(reachedAt))}, which reaches it.`}
            </p>
            <p className="mt-2 max-w-prose text-sm text-ink-soft">
              Climbing is not something Fiar can sell you. People who know you have to vouch, in VouchMe.
            </p>
          </div>
        )}
      </section>

      <section className="card px-4 py-4 pl-9" aria-label="Price by standing">
        <Ladder rungs={rungs} you={youRung(item, standing)} />
        <p className="mt-3 border-t border-rule-card pt-2 text-sm leading-relaxed text-ink-soft">
          Every rung is the same item, quoted by the same rule. Nothing here can be bought — a score is not for sale,
          and Fiar could not sell you one if it were.
        </p>
      </section>

      <footer className="border-t border-rule pt-3">
        <Provenance meta={standing?.meta ?? null} />
      </footer>
    </main>
  );
}
