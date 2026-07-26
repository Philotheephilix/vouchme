/** Vouch slots as a segmented row: used slots filled with brand, free slots left as hairline tracks. */
export function SlotDots({ total, used }: { total: number; used: number }) {
  const free = total - used;
  return (
    <div data-testid="slot-lines">
      <div className="mb-2 flex items-baseline justify-between">
        <span className="eyebrow">Your slots</span>
        <span className="font-mono text-2xs text-graphite">
          {free} of {total} free
        </span>
      </div>
      <div className="flex gap-1.5">
        {Array.from({ length: total }, (_, i) => (
          <span
            key={i}
            className="h-1.5 flex-1 rounded-full"
            style={{ backgroundColor: i < used ? "var(--color-seal)" : "var(--color-rule)" }}
          />
        ))}
      </div>
    </div>
  );
}
