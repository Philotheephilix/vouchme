import { Header } from "@/components/Header";
import { ENROLLMENT_BASE_SCORE } from "@/lib/mock";

export default function EnrollPage() {
  return (
    <div className="pb-8">
      <Header eyebrow="ENROLL" />

      <section className="px-4 pt-10 text-center">
        <h1 className="font-serif text-cream" style={{ fontSize: "var(--text-2xl)" }}>
          Aval
        </h1>
        <p className="mx-auto mt-4 max-w-xs text-sm leading-relaxed text-cream">
          Proof of human is a floor.
          <br />
          This is the ladder.
        </p>

        <button
          type="button"
          className="mt-8 min-h-[44px] w-full border px-4 py-3 font-mono text-xs uppercase tracking-widest"
          style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
        >
          Verify with World ID
        </button>
        <p className="mt-2 font-mono text-2xs text-graphite">Selfie Check · ~20 seconds</p>
      </section>

      <div className="my-10 border-t border-rule" />

      <section className="px-4">
        <div className="mb-3 font-mono text-2xs uppercase tracking-widest text-graphite">
          After you verify — score {ENROLLMENT_BASE_SCORE.toFixed(1)}, tier 0
        </div>
        <p className="text-sm leading-relaxed text-cream">
          You&apos;re verified as a live human. That&apos;s the floor. It doesn&apos;t yet prove you only have
          one account — for that, two people who are already trusted need to vouch for you.
        </p>
        <button
          type="button"
          className="mt-6 min-h-[44px] w-full border px-4 py-3 font-mono text-xs uppercase tracking-widest text-cream"
          style={{ borderColor: "var(--color-rule)" }}
        >
          Find people who can vouch
        </button>
      </section>
    </div>
  );
}
