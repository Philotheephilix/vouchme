export function AnchorOrb({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="An orb with a filled core and a downward anchor mark, an anchor"
    >
      {/* soft background blob */}
      <circle cx={120} cy={116} r={82} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* the orb ring + filled core */}
      <circle cx={120} cy={100} r={44} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      <circle cx={120} cy={100} r={16} fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} />

      {/* short beam ticks */}
      <path d="M120 44v-10" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M164 100h10" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M76 100H66" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* anchor mark: downward line + chevron */}
      <path d="M120 116v72" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M104 172l16 18 16-18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
