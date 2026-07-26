export function LoginHero({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="A small trust graph, one filled center node joined by edges to three outline nodes"
    >
      {/* soft background blob */}
      <circle cx={120} cy={120} r={82} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* edges from the center node to each outer node */}
      <path
        d="M120 120L80 78M120 120L172 84M120 120L108 176"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />

      {/* center node (filled) */}
      <circle cx={120} cy={120} r={13} fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} />

      {/* outer outline nodes */}
      <circle cx={80} cy={78} r={8} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      <circle cx={172} cy={84} r={8} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      <circle cx={108} cy={176} r={8} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}
