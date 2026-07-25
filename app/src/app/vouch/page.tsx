"use client";

import { useState } from "react";
import { Header } from "@/components/Header";
import { StatLine } from "@/components/StatLine";
import { fmtHours, fmtScore, tierLabel } from "@/lib/format";
import { CANDIDATES, VOUCH_SIMULATION } from "@/lib/mock";

const STEPS = ["Who?", "Preview", "Confirm", "Presence", "Transaction", "Result"] as const;

export default function VouchPage() {
  const [step, setStep] = useState(0);
  const [chosen, setChosen] = useState(CANDIDATES[0]?.ensName ?? "");

  const sim = VOUCH_SIMULATION;
  const last = step === STEPS.length - 1;
  const first = step === 0;

  return (
    <div className="pb-8">
      <Header eyebrow="VOUCH" title={`step ${step + 1} of ${STEPS.length} — ${STEPS[step]}`} />

      <ol className="scroll-x flex gap-3 border-b border-rule px-4 py-3">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className="whitespace-nowrap font-mono text-2xs uppercase tracking-widest"
            style={{ color: i === step ? "var(--color-seal)" : i < step ? "var(--color-cream)" : "var(--color-graphite)" }}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      <section className="px-4 pt-6">
        {step === 0 ? (
          <div>
            <h2 className="mb-3 text-sm text-cream">Who are you vouching for?</h2>
            <p className="mb-4 text-2xs text-graphite">Scan a QR, search a handle, or pick from prospective candidates.</p>
            <div>
              {CANDIDATES.map((c) => (
                <button
                  key={c.ensName}
                  type="button"
                  onClick={() => setChosen(c.ensName)}
                  className="flex w-full min-h-[44px] items-center justify-between border-b border-rule py-3 text-left"
                >
                  <span className="truncate-mono max-w-[180px] text-sm" style={{ color: chosen === c.ensName ? "var(--color-cream)" : "var(--color-graphite)" }}>
                    {c.ensName}
                  </span>
                  <span className="font-mono text-2xs text-graphite">
                    {tierLabel(c.tier)} · {fmtScore(c.score)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {step === 1 ? (
          <div>
            <h2 className="mb-3 text-sm text-cream">aval_simulate_vouch</h2>
            <StatLine
              label={sim.target}
              value={`${fmtScore(sim.targetBefore.score)} → ${fmtScore(sim.targetAfter.score)}`}
              hint={`${tierLabel(sim.targetBefore.tier)} → ${tierLabel(sim.targetAfter.tier)}${sim.promotes ? " — promotes" : ""}`}
              valueColor="var(--color-seal)"
            />
            <StatLine
              label="You"
              value={`${sim.voucherSlotsBefore} slots → ${sim.voucherSlotsAfter}`}
              hint={`next vouch in ${fmtHours(sim.nextVouchAvailableInHours)}`}
            />
            {sim.secondaryEffects.map((s) => (
              <StatLine
                key={s.ensName}
                label={`also raises ${s.ensName}`}
                value={`${fmtScore(s.before)} → ${fmtScore(s.after)}`}
              />
            ))}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="border px-4 py-3" style={{ borderColor: "var(--color-protest)" }}>
            <p className="text-sm leading-relaxed text-cream">
              <span className="font-mono" style={{ color: "var(--color-protest)" }}>
                ⚠
              </span>{" "}
              You are putting your name on this person. If they&apos;re confirmed fraudulent, you lose a slot
              for 30 days.
            </p>
          </div>
        ) : null}

        {step === 3 ? (
          <div>
            <h2 className="mb-3 text-sm text-cream">World ID</h2>
            <p className="text-2xs leading-relaxed text-graphite">
              <code className="font-mono">require_user_presence: true</code> — a vouch is the only operation
              that creates trust from nothing, so this is the one place the protocol spends friction.
            </p>
          </div>
        ) : null}

        {step === 4 ? (
          <div>
            <h2 className="mb-3 text-sm text-cream">Transaction</h2>
            <p className="font-mono text-2xs text-graphite">AvalRegistry.vouch(...) on World Chain</p>
          </div>
        ) : null}

        {step === 5 ? (
          <div>
            <h2 className="mb-3 text-sm text-cream">Minted</h2>
            <p className="truncate-mono text-base" style={{ color: "var(--color-seal)" }}>
              {sim.target}
            </p>
          </div>
        ) : null}
      </section>

      <div className="mt-8 flex gap-3 px-4">
        <button
          type="button"
          disabled={first}
          onClick={() => setStep((s: number) => Math.max(0, s - 1))}
          className="min-h-[44px] flex-1 border px-4 font-mono text-xs uppercase tracking-widest text-graphite disabled:opacity-30"
          style={{ borderColor: "var(--color-rule)" }}
        >
          Back
        </button>
        <button
          type="button"
          disabled={last}
          onClick={() => setStep((s: number) => Math.min(STEPS.length - 1, s + 1))}
          className="min-h-[44px] flex-1 border px-4 font-mono text-xs uppercase tracking-widest disabled:opacity-30"
          style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
        >
          {last ? "Done" : "Next"}
        </button>
      </div>
    </div>
  );
}
