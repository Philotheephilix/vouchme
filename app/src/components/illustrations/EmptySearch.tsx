export function EmptySearch({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="A magnifier hovering over a few dots, nothing found"
    >
      {/* soft background blob */}
      <circle cx={120} cy={120} r={82} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* the dots being searched */}
      <circle cx={92} cy={150} r={3} fill="var(--color-accent)" />
      <circle cx={120} cy={158} r={3} fill="var(--color-accent)" />
      <circle cx={148} cy={150} r={3} fill="var(--color-accent)" />

      {/* magnifier ring */}
      <circle cx={116} cy={108} r={38} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />

      {/* handle */}
      <path d="M144 136l24 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}
