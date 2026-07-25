import { cookies } from "next/headers";
import { isAddress } from "viem";
import { notFound } from "next/navigation";
import { Header } from "@/components/Header";
import { TierBadge } from "@/components/TierBadge";
import { VouchRow } from "@/components/VouchRow";
import { fmtScore, truncateMiddle } from "@/lib/format";
import { loadAvalData } from "@/lib/mock";
import type { Address } from "@/lib/types";

/** "Show the credential as a real object" — expiry read live from `credentialExpiresAt`, not
 *  hidden. Anchor status is read live from GenesisAnchorBook (docs/03-worldid.md §3), the
 *  authoritative signal — more trustworthy than the self-reported credential byte at enrollment
 *  time, so `kind === "anchor"` (not the raw enrollment credential) decides orb vs. selfie here. */
function credentialLine(subject: { kind: string; credentialStatus: string; credentialExpiresAt: string }): string {
  if (subject.kind === "anchor") return "credential: orb · anchor";
  const daysLeft = Math.round((new Date(subject.credentialExpiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (subject.credentialStatus === "suspended") return "credential: selfie check · expired, suspended";
  if (subject.credentialStatus === "grace") return `credential: selfie check · grace period, ${Math.max(0, daysLeft + 14)}d left`;
  return `credential: selfie check · ${Math.max(0, daysLeft)}d of 90 remaining`;
}

export const dynamic = "force-dynamic";

/**
 * Another Aval member's profile — their score, tier, depth, and who vouched for them, plus a
 * primary "Vouch" action with the real on-chain constraints displayed *before* it's enabled
 * (product direction: search + profile + vouch-from-profile).
 */
export default async function ProfilePage({ params }: { params: Promise<{ idOrAddress: string }> }) {
  const { idOrAddress } = await params;
  const decoded = decodeURIComponent(idOrAddress);

  const cookieStore = await cookies();
  const cookieAddr = cookieStore.get("aval_addr")?.value;
  const viewingAddress = cookieAddr && isAddress(cookieAddr) ? (cookieAddr as Address) : undefined;

  const data = await loadAvalData(viewingAddress);
  const subject = data.getScoreResult(decoded);
  if (!subject) notFound();

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
        <p className="mt-2 font-mono text-2xs text-graphite">
          @{subject.ensName.replace(/\.aval\.eth$/, "")} · depth {subject.depth ?? "∞"}
        </p>
        <p className="mt-1 font-mono text-2xs text-graphite" data-testid="credential-line">
          {credentialLine(subject)}
        </p>
        <p className="truncate-mono mt-1 font-mono text-2xs text-graphite">{subject.address}</p>
      </section>

      <section className="mt-6 px-4">
        <h2 className="mb-1 text-2xs uppercase tracking-widest text-graphite">Vouched for by</h2>
        {subject.breakdown.length === 0 ? (
          <p className="py-3 text-2xs text-graphite">No vouches yet.</p>
        ) : (
          subject.breakdown.map((row) => <VouchRow key={row.voucher.ensName} row={row} />)
        )}
      </section>

      {isSelf ? (
        <section className="mt-8 px-4">
          <div className="mb-2 font-mono text-2xs uppercase tracking-widest text-graphite">More</div>
          <a href="/explore" className="flex min-h-[44px] items-center border-b border-rule text-sm text-cream">
            Explore — honest path vs. collusion ring
          </a>
          <a href="/reports" className="flex min-h-[44px] items-center border-b border-rule text-sm text-cream">
            Reports — against you / filed by you
          </a>
          <a href="/agents" className="flex min-h-[44px] items-center border-b border-rule text-sm text-cream">
            Agents — mint an ENSIP-26 agent subname
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
