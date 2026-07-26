export function VouchCeremony({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Two nodes joined by an edge with a sealed check at the midpoint, a vouch"
    >
      {/* soft background blob */}
      <circle cx={120} cy={120} r={82} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* connecting edge between the two parties */}
      <path d="M72 120h96" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* left node (voucher) */}
      <circle cx={72} cy={120} r={14} fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} />

      {/* right node (vouched-for) */}
      <circle cx={168} cy={120} r={14} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />

      {/* sealed check at the midpoint */}
      <circle cx={120} cy={120} r={18} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      <path d="M112 120l5 6 11-13" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
