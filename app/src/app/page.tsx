import { cookies } from "next/headers";
import { DripCard } from "@/components/DripCard";
import { Header } from "@/components/Header";
import { ScoreDial } from "@/components/ScoreDial";
import { SearchBox } from "@/components/SearchBox";
import { SlotDots } from "@/components/SlotDots";
import { VouchRow } from "@/components/VouchRow";
import { WeakestLink } from "@/components/WeakestLink";
import { readVerifiedAddress } from "@/lib/authSession";
import { anchorSourceLabel, fmtScore, scoreTerms } from "@/lib/format";
import {
  ANCHOR_VOUCH_CONTRIBUTION,
  TIER_1_THRESHOLD_SCORE,
  loadAvalData,
} from "@/lib/mock";

// LIVE mode reads World Chain Sepolia on every request — never bake a snapshot into the build.
export const dynamic = "force-dynamic";

/**
 * The signed-in, enrolled dashboard. `AppGate` (src/components/AppGate.tsx) guarantees nobody
 * reaches this without both a session and a live `Enrolled` record — product direction: "don't
 * show random data like others... after verification and subname minting go inside and show
 * their score." There is no demo/fallback identity here any more: absent the session cookie this
 * renders nothing and reads no chain data, full stop — `AppGate` is already showing the login
 * screen in that case, so this would just be wasted work computing data nobody sees.
 */
export default async function HomePage() {
  const cookieStore = await cookies();
  // docs/96-ux-audit.md U-24: this used to trust the raw, client-writable `aval_addr` cookie
  // directly, which meant setting that cookie to any address rendered that address's real
  // dashboard — no signature required. `readVerifiedAddress` only returns an address whose session
  // was minted after a real wallet signature verified server-side (src/lib/authSession.ts).
  const viewingAddress = readVerifiedAddress(cookieStore) ?? undefined;
  if (!viewingAddress) return null;

  const data = await loadAvalData(viewingAddress);
  const { ME } = data;
  const enrolled = data.isEnrolled(ME.address);
  const countedVouchCount = ME.breakdown.filter((b) => b.counted).length;
  const isAnchor = ME.kind === "anchor";
  const { terms, total, matchesScore } = scoreTerms(ME);

  // What it would actually take to reach Tier 1 from here, computed rather than asserted.
  // This line used to read "Three people who are already trusted need to vouch for you" —
  // hardcoded, and false twice over: it was shown to a Tier 2 anchor with a score of 100 on this
  // deployment, and even for a real Tier 0 account the count depends entirely on who the vouchers
  // are (docs/95-lifecycle.md L-4; errata E-16: two anchors clear T1, three ordinary Tier 1
  // members clear it, two ordinary members do not).
  const pointsToTier1 = Math.max(0, TIER_1_THRESHOLD_SCORE - ME.score);
  const anchorsToTier1 = Math.ceil(pointsToTier1 / ANCHOR_VOUCH_CONTRIBUTION);
  const sumLine = terms.map((t) => `${t.label} ${fmtScore(t.value)}`).join(" + ");

  return (
    <div className="pb-8">
      <Header eyebrow="BEARER" title={ME.ensName} />

      <section className="px-4 pt-4">
        <SearchBox />
      </section>

      <section className="px-4 pt-6">
        <ScoreDial score={ME.score} tier={ME.tier} countedVouchCount={countedVouchCount} />
        {/* `depth {null}` rendered the word "depth" followed by nothing at all for anyone with no
            path to an anchor — a labelled field with no value (docs/95-lifecycle.md L-12). */}
        <p className="mt-1 text-center font-mono text-2xs uppercase tracking-widest text-graphite">
          {ME.depth === null ? "no path to an anchor yet" : `depth ${ME.depth}`}
        </p>
        {isAnchor ? (
          <p className="mt-1 text-center font-mono text-2xs uppercase tracking-widest" style={{ color: "var(--color-anchor)" }}>
            {anchorSourceLabel(ME.anchorSource)}
          </p>
        ) : null}
      </section>

      <section className="mt-4 px-4">
        <h2 className="mb-1 text-2xs uppercase tracking-widest text-graphite">Vouched for by</h2>
        <div>
          {ME.breakdown.length === 0 ? (
            <p className="py-3 text-2xs leading-relaxed text-graphite" data-testid="no-vouches">
              {isAnchor
                ? "No inbound vouches. It makes no difference to your score: an anchor's score is fixed, and inbound vouches are recorded but never counted."
                : ME.tier >= 1
                  ? "No vouch counts toward your score yet."
                  : `No vouches yet. You need ${fmtScore(pointsToTier1)} more points to reach Tier 1 (${fmtScore(
                      TIER_1_THRESHOLD_SCORE,
                    )}). An Orb-verified anchor's vouch is worth +${fmtScore(
                      ANCHOR_VOUCH_CONTRIBUTION,
                    )}, so ${anchorsToTier1} of those would do it; ordinary members are worth a quarter of their own score, so it takes more of them.`}
            </p>
          ) : (
            ME.breakdown.map((row) => <VouchRow key={row.voucher.ensName} row={row} />)
          )}
        </div>

        {/* The arithmetic under the dial has to equal the dial. It printed `base 10.0 + 45.0 =
            55.0` under 65.0 once (docs/96-ux-audit.md U-3), and `base 20.0 + 0.0 = 20.0` under
            100.0 for this deployment's Orb-verified account. Anchors have no sum to show at all
            (errata E-6), and any other mismatch means the terms are incomplete — in which case
            print no equation rather than a wrong one. */}
        <div className="mt-4 border-t border-rule pt-3 font-mono text-sm text-cream" data-testid="score-equation">
          {isAnchor
            ? `anchor — score fixed at ${fmtScore(ME.score)}`
            : matchesScore
              ? `${sumLine} = ${fmtScore(total)}`
              : total > ME.score
                ? `${sumLine} = ${fmtScore(total)}, less reports = ${fmtScore(ME.score)}`
                : `score ${fmtScore(ME.score)} — this screen can't account for all of it, so it isn't showing a sum`}
        </div>
      </section>

      {ME.weakestLink ? (
        <section className="mt-6 px-4">
          <WeakestLink link={ME.weakestLink} />
        </section>
      ) : null}

      <section className="mt-6 px-4">
        {/* "YOUR SLOTS 0 of 0 free" with three grey marks reads as "you used up your allowance",
            which is the opposite of the truth (docs/95-lifecycle.md L-13). */}
        {ME.slots.total === 0 ? (
          <div>
            <div className="mb-1 text-2xs uppercase tracking-widest text-graphite">Your slots</div>
            <p className="text-2xs text-graphite">Vouching unlocks at Tier 1 — Tier 0 accounts have no slots.</p>
          </div>
        ) : (
          <SlotDots total={ME.slots.total} used={ME.slots.used} />
        )}
      </section>

      {ME.presence ? (
        <section className="mt-6 px-4">
          <DripCard presence={ME.presence} address={ME.address} canClaim={enrolled} />
        </section>
      ) : null}
    </div>
  );
}
