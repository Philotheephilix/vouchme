export function EmptyReports({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Stacked ledger tiles with two empty dashed lines, nothing logged yet"
    >
      {/* soft background blob */}
      <circle cx={120} cy={120} r={82} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* tiles stacked behind */}
      <rect x={82} y={74} width={92} height={30} rx={8} fill="var(--color-accent)" fillOpacity={0.15} stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

      {/* the front tile */}
      <rect x={72} y={100} width={96} height={66} rx={10} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

      {/* two empty dashed lines */}
      <path d="M88 124h64" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeDasharray="2 8" />
      <path d="M88 142h44" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeDasharray="2 8" />
    </svg>
  );
}
