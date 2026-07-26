export function Presence({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Three rising bars, presence growing over time"
    >
      {/* soft background blob */}
      <circle cx={120} cy={120} r={82} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* rising bars */}
      <rect x={70} y={140} width={26} height={40} rx={5} fill="var(--color-accent)" fillOpacity={0.15} stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <rect x={108} y={110} width={26} height={70} rx={5} fill="var(--color-accent)" fillOpacity={0.15} stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <rect x={146} y={78} width={26} height={102} rx={5} fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
    </svg>
  );
}
