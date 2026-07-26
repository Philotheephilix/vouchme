import type { Standing } from "@vouchme/minikit-sdk";
import { points, tierLabel, usd } from "@/lib/format";
import { POLICY } from "@/lib/policy";

/**
 * The borrower's own card, filed at the top of the drawer.
 *
 * When there is no standing to show, this must say what is missing and how to fix it, not render a
 * row of zeros — a card that reads "0.0 / Tier 0" for somebody who has never heard of VouchMe is
 * describing Fiar's ignorance as if it were their reputation.
 */
export function HolderCard({
  holder,
  standing,
  unavailable,
  verified,
}: {
  holder: string | null;
  standing: Standing | null;
  unavailable: string | null;
  /** Whether a wallet signature actually proved this identity, or it is only being previewed.
   *  Stated on the card, because a preview and a verified session must not look the same. */
  verified: boolean;
}) {
  const ceiling = POLICY.ceilingBase + POLICY.ceilingPerTier * (standing?.tier ?? 0);

  return (
    <section className="card px-4 py-3 pl-9" aria-label="Your card">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-typed text-2xs uppercase tracking-[0.24em] text-ink-soft">Card holder</span>
        <span className={`font-typed text-2xs uppercase tracking-[0.18em] ${verified ? "text-stamp" : "text-ink-soft"}`}>
          {verified ? "Wallet verified" : "Preview only"}
        </span>
      </div>

      {standing ? (
        <>
          <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="font-typed text-base font-bold break-all">{standing.ensName}</h2>
            <div className="flex items-baseline gap-2">
              <span className="font-typed text-xl font-bold leading-none">{points(standing.score)}</span>
              <span className="border border-stamp px-1.5 py-0.5 font-typed text-2xs uppercase tracking-[0.18em] text-stamp">
                {tierLabel(standing.tier)}
              </span>
            </div>
          </div>
          <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 border-t border-rule-card pt-2 font-typed text-xs text-ink-soft">
            <div className="flex gap-1.5">
              <dt>Floor</dt>
              <dd className="text-ink">{points(standing.base)}</dd>
            </div>
            <div className="flex gap-1.5">
              <dt>Borrow up to</dt>
              <dd className="text-ink">{usd(ceiling)}</dd>
            </div>
            {standing.credentialStatus !== "active" ? (
              <div className="flex gap-1.5">
                <dt>Credential</dt>
                <dd className="text-limit">{standing.credentialStatus}</dd>
              </div>
            ) : null}
          </dl>
        </>
      ) : (
        <div className="mt-1">
          <h2 className="text-lg font-semibold">{unavailable ? "Standing unavailable" : "No standing yet"}</h2>
          <p className="mt-1 max-w-prose text-sm text-ink-soft">
            {unavailable
              ? `${unavailable} Everything below is priced as if you had no standing, which is the most it can ever cost.`
              : holder
                ? "Nobody has vouched for this account yet, so Fiar is quoting the full deposit. Get two people who know you to vouch in VouchMe and these numbers fall."
                : "Open Fiar inside World App, or add ?as=<name> to preview another card holder."}
          </p>
        </div>
      )}
    </section>
  );
}
