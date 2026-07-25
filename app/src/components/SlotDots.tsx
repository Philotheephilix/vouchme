/**
 * Slots rendered as countersignature lines rather than dots: short ruled lines, used ones marked,
 * free ones blank and waiting for a signature.
 */
export function SlotDots({ total, used }: { total: number; used: number }) {
  const free = total - used;
  return (
    <div data-testid="slot-lines">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="text-2xs uppercase tracking-widest text-graphite">Your slots</span>
        <span className="font-mono text-2xs text-graphite">
          {free} of {total} free
        </span>
      </div>
      <div className="flex flex-wrap gap-4">
        {Array.from({ length: total }, (_, i) => {
          const filled = i < used;
          return (
            <div key={i} className="flex w-12 flex-col items-center gap-1">
              {/* countersignature mark: an abstract ink stroke, not a literal word — a used slot
                  reads as "signed", not as a rendering bug. */}
              <svg
                aria-hidden="true"
                viewBox="0 0 48 16"
                width="48"
                height="16"
                className="block"
                style={{ visibility: filled ? "visible" : "hidden" }}
              >
                <path
                  d="M3 11 C6 3 10 3 13 8 C15 11 18 5 22 7 C25 9 28 4 32 6 C35 8 39 4 42 7 C44 9 45 10 46 9"
                  fill="none"
                  stroke="var(--color-cream)"
                  strokeWidth={1.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span
                className="h-px w-full"
                style={{ backgroundColor: filled ? "var(--color-seal)" : "var(--color-rule)" }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
