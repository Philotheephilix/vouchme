export function Minting({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="An identity token card with a seal check, being minted"
    >
      {/* soft background blob */}
      <circle cx={120} cy={120} r={82} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* the token card */}
      <rect x={70} y={80} width={100} height={80} rx={12} fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

      {/* seal disc with a check */}
      <circle cx={120} cy={120} r={20} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      <path d="M111 120l6 7 12-14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
