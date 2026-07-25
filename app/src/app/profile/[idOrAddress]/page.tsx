import { cookies } from "next/headers";
import { notFound } from "next/navigation";
import { CREDENTIAL_GRACE_DAYS, CREDENTIAL_VALIDITY_DAYS } from "@vouchme/engine";
import { Header } from "@/components/Header";
import { ReportStamp, reportEffectLine } from "@/components/ReportStamp";
import { TierBadge } from "@/components/TierBadge";
import { VouchRow } from "@/components/VouchRow";
import { readVerifiedAddress } from "@/lib/authSession";
import { fmtScore, truncateMiddle } from "@/lib/format";
import { loadVouchMeData } from "@/lib/mock";

/** "Show the credential as a real object" — expiry read live from `credentialExpiresAt`, not
 *  hidden. Anchor status is read live from GenesisAnchorBook (docs/03-worldid.md §3), the
 *  authoritative signal — more trustworthy than the self-reported credential byte at enrollment
 *  time, so `kind === "anchor"` (not the raw enrollment credential) decides orb vs. selfie here. */
function credentialLine(subject: { kind: string; credentialStatus: string; credentialExpiresAt: string }): string {
  if (subject.kind === "anchor") return "credential: orb · anchor";
  const daysLeft = Math.round((new Date(subject.credentialExpiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (subject.credentialStatus === "suspended") return "credential: selfie check · expired, suspended";
  // Window lengths come from the engine's constants so they cannot drift from the contract.
  if (subject.credentialStatus === "grace") {
    return `credential: selfie check · grace period, ${Math.max(0, daysLeft + CREDENTIAL_GRACE_DAYS)}d left`;
  }
  return `credential: selfie check · ${Math.max(0, daysLeft)}d of ${CREDENTIAL_VALIDITY_DAYS} remaining`;
}

export const dynamic = "force-dynamic";

/**
 * Another VouchMe member's profile — their score, tier, depth, and who vouched for them, plus a
 * primary "Vouch" action with the real on-chain constraints displayed *before* it's enabled
 * (product direction: search + profile + vouch-from-profile).
 */
export default async function ProfilePage({ params }: { params: Promise<{ idOrAddress: string }> }) {
  const { idOrAddress } = await params;
  const decoded = decodeURIComponent(idOrAddress);

  // Verified, not the raw `vouchme_addr` cookie — see src/app/page.tsx's comment on
  // readVerifiedAddress. `viewingAddress` here decides both whose data renders as "you"
  // (isSelf/vouch eligibility below) and, via loadVouchMeData, what a signed-out visitor gets — it
  // must never be forgeable.
  const cookieStore = await cookies();
  const viewingAddress = readVerifiedAddress(cookieStore) ?? undefined;
  // Return BEFORE reading any chain data, as every other gated route does (explore, reports,
  // platform, home): whatever renders here ships in the RSC payload, so a signed-out
  // `curl` would read the subject's handle, address, score, tier, depth, credential and full
  // voucher list. Rendering nothing is the gate; painting a login screen over it is not.
  if (!viewingAddress) return null;

  const data = await loadVouchMeData(viewingAddress);
  const subject = data.getScoreResult(decoded);
  if (!subject) notFound();

  // `REPORTS` carries every report in the graph (its `direction` is relative to the signed-in
  // viewer, which is not who this page is about), so select on the target itself.
  const reportsAgainstSubject = data.REPORTS.filter((r) => r.target === subject.ensName);

  const isSelf = viewingAddress ? subject.address.toLowerCase() === viewingAddress.toLowerCase() : false;
  const viewer = viewingAddress ? data.ME : null;

  const reasons: string[] = [];
  if (!viewingAddress) reasons.push("sign in to vouch");
  else if (isSelf) reasons.push("you cannot vouch for yourself");
  else if (viewer) {
    if (viewer.tier < 1) reasons.push(`you need Tier 1 to vouch — you're Tier ${viewer.tier} (${viewer.slots.used} of ${viewer.slots.total} slots used)`);
    else if (viewer.slots.free <= 0) reasons.push(`no free slots — ${viewer.slots.used} of ${viewer.slots.total} used`);
  }
  const canVouch = reasons.length === 0;

  return (
    <div className="pb-8">
      <Header eyebrow="PROFILE" title={subject.ensName} />

      <section className="px-4 pt-6">
        <div className="flex items-baseline justify-between border-b border-rule pb-4">
          <span className="font-serif text-cream" style={{ fontSize: "var(--text-2xl)" }}>
            {fmtScore(subject.score)}
          </span>
          <TierBadge tier={subject.tier} />
        </div>
        {/* Spelled out rather than shown as `depth ∞`: "not connected to any anchor" is the fact
            that most needs words. */}
        <p className="mt-2 font-mono text-2xs text-graphite">
          @{subject.ensName.replace(/\.vouchme\.eth$/, "")} ·{" "}
          {subject.depth === null ? "no path to an anchor" : `depth ${subject.depth}`}
        </p>
        <p className="mt-1 font-mono text-2xs text-graphite" data-testid="credential-line">
          {credentialLine(subject)}
        </p>
        <p className="truncate-mono mt-1 font-mono text-2xs text-graphite">{subject.address}</p>
      </section>

      {/* Reports against THIS account, whoever is looking. A profile that shows a score without
          showing the accusations already priced into it (or deliberately not priced in, for an
          anchor) is a profile that omits the one thing a reader most needs. `reportsAvailable`
          keeps the two empty states apart: "nobody has filed" vs "nobody asked the chain". */}
      <section className="mt-6 px-4">
        <h2 className="mb-1 text-2xs uppercase tracking-widest text-graphite">Reports</h2>
        {!data.reportsAvailable ? (
          <p className="py-3 text-2xs leading-relaxed text-graphite">
            Not read on this deployment — no ReportRegistry is configured, so this page cannot say whether anyone
            has been reported. Silence here is not a clean record.
          </p>
        ) : reportsAgainstSubject.length === 0 ? (
          <p className="py-3 text-2xs leading-relaxed text-graphite">
            No reports filed against this account. ReportRegistry was read at block {data.meta.computedAtBlock}.
          </p>
        ) : (
          <div className="space-y-3 py-2">
            {subject.scoreAtRisk !== subject.score ? (
              <p className="text-2xs leading-relaxed text-graphite">
                Score {fmtScore(subject.score)} · at risk {fmtScore(subject.scoreAtRisk)} — the second number prices
                in the open accusations below. Pending reports never change a tier (docs/01-trust-math.md §7.5).
              </p>
            ) : (
              <p className="text-2xs leading-relaxed text-graphite">
                Score {fmtScore(subject.score)}, unchanged by the report{reportsAgainstSubject.length > 1 ? "s" : ""} below —
                see why on each one.
              </p>
            )}
            {reportsAgainstSubject.map((r) => (
              <div key={r.id} className="border border-rule p-3">
                <div className="mb-2 flex items-start justify-between gap-3">
                  <span className="truncate-mono max-w-[180px] text-2xs text-cream">
                    from {truncateMiddle(r.reporter.ensName, 22)}
                  </span>
                  <ReportStamp report={r} now={data.NOW} />
                </div>
                <p className="text-2xs leading-relaxed text-graphite">{reportEffectLine(r)}</p>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6 px-4">
        <h2 className="mb-1 text-2xs uppercase tracking-widest text-graphite">Vouched for by</h2>
        {subject.breakdown.length === 0 ? (
          <p className="py-3 text-2xs leading-relaxed text-graphite">
            {subject.kind === "anchor"
              ? "No inbound vouches — and they would not change this score anyway: an anchor's score is fixed and ignores every inbound edge."
              : "No vouches yet."}
          </p>
        ) : (
          subject.breakdown.map((row) => <VouchRow key={row.voucher.ensName} row={row} />)
        )}
      </section>

      {isSelf ? (
        <section className="mt-8 px-4">
          <div className="mb-2 font-mono text-2xs uppercase tracking-widest text-graphite">More</div>
          <a href="/explore" className="flex min-h-[44px] items-center border-b border-rule text-sm text-cream">
            Explore — who reaches an anchor, and who doesn&apos;t reach one
          </a>
          <a href="/reports" className="flex min-h-[44px] items-center border-b border-rule text-sm text-cream">
            Reports — against you / filed by you
          </a>
        </section>
      ) : null}

      <section className="mt-8 px-4">
        {isSelf ? null : canVouch ? (
          <a href={`/vouch?to=${encodeURIComponent(subject.address)}`} data-testid="profile-vouch-cta">
            <button
              type="button"
              className="min-h-[44px] w-full border px-4 py-3 font-mono text-xs uppercase tracking-widest"
              style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
            >
              Vouch for {truncateMiddle(subject.ensName, 20)}
            </button>
          </a>
        ) : (
          <div>
            <button
              type="button"
              disabled
              className="min-h-[44px] w-full border px-4 py-3 font-mono text-xs uppercase tracking-widest opacity-40"
              style={{ borderColor: "var(--color-rule)" }}
            >
              Vouch for {truncateMiddle(subject.ensName, 20)}
            </button>
            <p className="mt-2 text-2xs" style={{ color: "var(--color-protest)" }} data-testid="vouch-blocked-reason">
              {reasons.join(" · ")}
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
