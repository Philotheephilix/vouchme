import { cookies } from "next/headers";
import { isAddress } from "viem";
import { DripCard } from "@/components/DripCard";
import { Header } from "@/components/Header";
import { ScoreDial } from "@/components/ScoreDial";
import { SearchBox } from "@/components/SearchBox";
import { SlotDots } from "@/components/SlotDots";
import { VouchRow } from "@/components/VouchRow";
import { WeakestLink } from "@/components/WeakestLink";
import { loadAvalData } from "@/lib/mock";
import type { Address } from "@/lib/types";

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
  const cookieAddr = cookieStore.get("aval_addr")?.value;
  const viewingAddress = cookieAddr && isAddress(cookieAddr) ? (cookieAddr as Address) : undefined;
  if (!viewingAddress) return null;

  const data = await loadAvalData(viewingAddress);
  const { ME } = data;
  const enrolled = data.isEnrolled(ME.address);
  const countedVouchCount = ME.breakdown.filter((b) => b.counted).length;
  const countedSum = ME.breakdown.filter((b) => b.counted).reduce((sum, b) => sum + b.contribution, 0);

  return (
    <div className="pb-8">
      <Header eyebrow="BEARER" title={ME.ensName} />

      <section className="px-4 pt-4">
        <SearchBox />
      </section>

      <section className="px-4 pt-6">
        <ScoreDial score={ME.score} tier={ME.tier} countedVouchCount={countedVouchCount} />
        <p className="mt-1 text-center font-mono text-2xs uppercase tracking-widest text-graphite">
          depth {ME.depth}
        </p>
      </section>

      <section className="mt-4 px-4">
        <h2 className="mb-1 text-2xs uppercase tracking-widest text-graphite">Vouched for by</h2>
        <div>
          {ME.breakdown.length === 0 ? (
            <p className="py-3 text-2xs text-graphite" data-testid="no-vouches">
              No vouches yet. Two people who are already trusted need to vouch for you before you
              reach Tier 1.
            </p>
          ) : (
            ME.breakdown.map((row) => <VouchRow key={row.voucher.ensName} row={row} />)
          )}
        </div>

        <div className="mt-4 border-t border-rule pt-3 font-mono text-sm text-cream">
          base {ME.base.toFixed(1)} + {countedSum.toFixed(1)} = {(ME.base + countedSum).toFixed(1)}
        </div>
      </section>

      {ME.weakestLink ? (
        <section className="mt-6 px-4">
          <WeakestLink link={ME.weakestLink} />
        </section>
      ) : null}

      <section className="mt-6 px-4">
        <SlotDots total={ME.slots.total} used={ME.slots.used} />
      </section>

      {ME.presence ? (
        <section className="mt-6 px-4">
          <DripCard presence={ME.presence} address={ME.address} canClaim={enrolled} />
        </section>
      ) : null}
    </div>
  );
}
