export function Success({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="A bold checkmark inside a single ring, done"
    >
      {/* soft background blob */}
      <circle cx={120} cy={120} r={82} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* the ring */}
      <circle cx={120} cy={120} r={54} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />

      {/* the big checkmark */}
      <path d="M98 122l15 17 30-36" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
