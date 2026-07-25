import { DripCard } from "@/components/DripCard";
import { Header } from "@/components/Header";
import { ScoreDial } from "@/components/ScoreDial";
import { SlotDots } from "@/components/SlotDots";
import { VouchRow } from "@/components/VouchRow";
import { WeakestLink } from "@/components/WeakestLink";
import { ME } from "@/lib/mock";

export default function HomePage() {
  const countedVouchCount = ME.breakdown.filter((b) => b.counted).length;
  const countedSum = ME.breakdown.filter((b) => b.counted).reduce((sum, b) => sum + b.contribution, 0);

  return (
    <div className="pb-8">
      <Header eyebrow="BEARER" title={ME.ensName} />

      <section className="px-4 pt-6">
        <ScoreDial score={ME.score} tier={ME.tier} countedVouchCount={countedVouchCount} />
        <p className="mt-1 text-center font-mono text-2xs uppercase tracking-widest text-graphite">
          depth {ME.depth}
        </p>
      </section>

      <section className="mt-4 px-4">
        <h2 className="mb-1 text-2xs uppercase tracking-widest text-graphite">Vouched for by</h2>
        <div>
          {ME.breakdown.map((row) => (
            <VouchRow key={row.voucher.ensName} row={row} />
          ))}
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
          <DripCard presence={ME.presence} />
        </section>
      ) : null}
    </div>
  );
}
