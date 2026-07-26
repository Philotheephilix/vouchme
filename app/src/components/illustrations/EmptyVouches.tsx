export function EmptyVouches({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Three outline nodes joined by a line with one filled seed node, a graph waiting to grow"
    >
      {/* soft background blob */}
      <circle cx={120} cy={120} r={82} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* connecting line */}
      <path d="M74 120h92" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* the filled seed node */}
      <circle cx={74} cy={120} r={13} fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} />

      {/* outline nodes waiting */}
      <circle cx={120} cy={120} r={10} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      <circle cx={166} cy={120} r={10} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}
