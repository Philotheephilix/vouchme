import { cookies } from "next/headers";
import Link from "next/link";
import { Sunburst } from "@/components/Artifacts";
import { DripCard } from "@/components/DripCard";
import { FaceMesh } from "@/components/FaceMesh";
import { Header } from "@/components/Header";
import { SlotDots } from "@/components/SlotDots";
import { VouchRow } from "@/components/VouchRow";
import { WeakestLink } from "@/components/WeakestLink";
import { readVerifiedAddress } from "@/lib/authSession";
import { anchorSourceLabel, fmtScore, scoreTerms } from "@/lib/format";
import {
  ANCHOR_VOUCH_CONTRIBUTION,
  TIER_1_THRESHOLD_SCORE,
  loadVouchMeData,
} from "@/lib/mock";

// LIVE mode reads World Chain Sepolia on every request — never bake a snapshot into the build.
export const dynamic = "force-dynamic";

/**
 * The signed-in, enrolled dashboard. `AppGate` (src/components/AppGate.tsx) guarantees nobody
 * reaches this without both a session and a live `Enrolled` record. There is no demo or fallback
 * identity: absent the session cookie this renders nothing and reads no chain data, full stop —
 * `AppGate` is already showing the login screen in that case.
 */
export default async function HomePage() {
  const cookieStore = await cookies();
  // `readVerifiedAddress` only returns an address whose session was minted after a real wallet
  // signature verified server-side (src/lib/authSession.ts). The raw `vouchme_addr` cookie is
  // client-writable, so trusting it directly would render any address's real dashboard to anyone
  // who set it.
  const viewingAddress = readVerifiedAddress(cookieStore) ?? undefined;
  if (!viewingAddress) return null;

  const data = await loadVouchMeData(viewingAddress);
  const { ME } = data;
  const enrolled = data.isEnrolled(ME.address);
  const isAnchor = ME.kind === "anchor";
  const { terms, total, matchesScore } = scoreTerms(ME);

  // What it would actually take to reach Tier 1 from here, computed rather than asserted: the
  // count is never a constant, because it depends entirely on who the vouchers are.
  const pointsToTier1 = Math.max(0, TIER_1_THRESHOLD_SCORE - ME.score);
  const anchorsToTier1 = Math.ceil(pointsToTier1 / ANCHOR_VOUCH_CONTRIBUTION);
  const sumLine = terms.map((t) => `${t.label} ${fmtScore(t.value)}`).join(" + ");

  return (
    <div className="pb-8">
      <Header title="Your standing" subtitle={`${ME.ensName} · Tier ${ME.tier}`} />

      <section className="anim-pop-bounce relative px-4 pt-4">
        {/* a still poster sunburst behind the face — depth, not motion. The face is the one thing
            that should move (it coheres with reputation); a spinning halo only competes with it. */}
        <Sunburst
          size={340}
          rays={100}
          weight={1}
          className="artifact"
          style={{
            position: "absolute",
            top: -18,
            left: "50%",
            marginLeft: -170,
            color: "color-mix(in oklab, var(--color-accent) 9%, transparent)",
            zIndex: 0,
          }}
        />
        {/* The face is the score, worn as a face: a per-identity particle bust that is a cloud of
            granules at low standing and coheres into a formed face as reputation climbs. It floats
            on the page itself — no card behind it — so the granules read as suspended in space. */}
        <div className="relative z-[1]">
          <FaceMesh
          address={ME.address}
          score={ME.score}
          tier={ME.tier}
          isAnchor={isAnchor}
          height={260}
        />

        <div className="-mt-3 px-1">
          <div className="flex items-baseline gap-0.5" data-testid="home-score-figure">
            <span
              className="font-mono"
              style={{ fontSize: "clamp(46px, 15vw, 56px)", fontWeight: 700, letterSpacing: "-.04em", lineHeight: 1 }}
            >
              {fmtScore(ME.score).split(".")[0]}
            </span>
            <span className="font-mono text-graphite" style={{ fontSize: 24, fontWeight: 500 }}>
              .{fmtScore(ME.score).split(".")[1] ?? "0"}
            </span>
          </div>

          {/* Tier 0 is a state to grow out of, so show it as progress toward Tier 1 — a labelled
              meter, not a flat badge. Anchors and Tier 1+ keep the taxonomy chips. */}
          {!isAnchor && ME.tier === 0 ? (
            <div className="mt-3.5 max-w-[280px]">
              <div className="mb-1.5 flex items-baseline justify-between font-mono text-2xs">
                <span className="badge" style={{ background: "var(--color-paper-2)", color: "var(--color-graphite)" }}>
                  Tier 0
                </span>
                <span className="text-graphite">{fmtScore(pointsToTier1)} to Tier&nbsp;1</span>
              </div>
              <div className="relative h-2 w-full overflow-hidden rounded-full" style={{ backgroundColor: "var(--color-rule-strong)" }}>
                <div
                  className="absolute left-0 top-0 h-full rounded-full"
                  style={{
                    width: `${Math.min(100, (ME.score / TIER_1_THRESHOLD_SCORE) * 100)}%`,
                    background: "linear-gradient(90deg,var(--color-accent),var(--color-accent-dark))",
                  }}
                />
              </div>
              <div className="mt-1.5 text-2xs text-graphite">
                {ME.depth === null ? "No anchor path yet" : `Depth ${ME.depth} · reaches an anchor`}
              </div>
            </div>
          ) : (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span
                className="badge"
                style={{
                  background: isAnchor ? "var(--color-anchor-subtle)" : "var(--color-seal-subtle)",
                  color: isAnchor ? "var(--color-anchor)" : "var(--color-seal)",
                }}
              >
                Tier {ME.tier}
              </span>
              <span className="badge badge-outline text-graphite">
                {ME.depth === null ? "No anchor path" : `Depth ${ME.depth} · reaches an anchor`}
              </span>
              {isAnchor ? (
                <span className="badge badge-outline text-anchor">{anchorSourceLabel(ME.anchorSource)}</span>
              ) : null}
            </div>
          )}
          </div>
        </div>
      </section>

      {/* Presence drip moved up: the daily earn sits right under the face, above the ledger. */}
      {ME.presence ? (
        <section className="mt-5 px-4">
          <DripCard presence={ME.presence} address={ME.address} canClaim={enrolled} />
        </section>
      ) : null}

      <section className="mt-5 px-4">
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="eyebrow">Vouched for by</h2>
          {ME.breakdown.length > 0 ? (
            <span className="font-mono text-2xs text-graphite">{ME.breakdown.length}</span>
          ) : null}
        </div>
        {ME.breakdown.length === 0 ? (
          <div className="card px-4 py-4 text-center">
            <p className="text-2xs leading-relaxed text-graphite" data-testid="no-vouches">
              {isAnchor
                ? "No inbound vouches — and an anchor's score is fixed, so they wouldn't count anyway."
                : ME.tier >= 1
                  ? "No vouch counts toward your score yet."
                  : `No vouches yet. ${fmtScore(pointsToTier1)} more points reaches Tier 1, about ${anchorsToTier1} anchor vouch${anchorsToTier1 === 1 ? "" : "es"}.`}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {ME.breakdown.map((row) => (
              <VouchRow key={row.voucher.ensName} row={row} compact />
            ))}
          </div>
        )}

        {/* The arithmetic under the ledger has to equal the dial. Demoted to a quiet caption, not a
            second coloured card: the page already carries the blue drip and the green CTA, so this
            stays mono graphite. An anchor has no sum, and any mismatch prints no false equation. */}
        <p className="mt-2.5 px-1 font-mono text-2xs leading-relaxed text-graphite" data-testid="score-equation">
          {isAnchor
            ? `anchor · score fixed at ${fmtScore(ME.score)}`
            : matchesScore
              ? `${sumLine} = ${fmtScore(total)}`
              : total > ME.score
                ? `${sumLine} = ${fmtScore(total)}, less reports = ${fmtScore(ME.score)}`
                : `score ${fmtScore(ME.score)}`}
        </p>
      </section>

      {ME.weakestLink ? (
        <section className="mt-6 px-4">
          <WeakestLink link={ME.weakestLink} />
        </section>
      ) : null}

      <section className="mt-6 px-4">
        {/* Zero slots means vouching is not unlocked yet, not "you used up your allowance" —
            which is how empty slot dots read. */}
        <div className="card p-4">
          {ME.slots.total === 0 ? (
            <>
              <div className="eyebrow mb-1">Your slots</div>
              <p className="text-2xs text-graphite">Vouching unlocks at Tier 1. Tier 0 accounts have no slots.</p>
            </>
          ) : (
            <SlotDots total={ME.slots.total} used={ME.slots.used} />
          )}
        </div>
      </section>

      {/* the one thing you can do — the wallet's mint feature card, carrying Home's primary action */}
      {ME.slots.total > 0 ? (
        <section className="mt-6 px-4">
          <Link href="/vouch" className="promo-card card-tap flex items-center justify-between gap-4 p-5" data-testid="home-vouch-cta">
            <div>
              <div className="text-lg font-bold tracking-tight" style={{ color: "#12321f" }}>
                Vouch for someone
              </div>
              <div className="mt-1 text-xs font-medium" style={{ color: "#3c6650" }}>
                {ME.slots.total - ME.slots.used} of {ME.slots.total} slots free · your name on the line
              </div>
            </div>
            <span
              className="flex items-center justify-center"
              style={{ width: 42, height: 42, borderRadius: 999, background: "#fff", flex: "none" }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M4 12 12 4M12 4H5.5M12 4v6.5" stroke="#12321f" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          </Link>
        </section>
      ) : null}
    </div>
  );
}
