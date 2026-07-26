export function TrustGraph({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="A hub node joined by spokes to five outline nodes, a trust graph"
    >
      {/* soft background blob */}
      <circle cx={120} cy={120} r={88} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* spokes from hub to each outer node */}
      <path
        d="M120 120L76 72M120 120L176 74M120 120L184 138M120 120L128 184M120 120L54 148"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />

      {/* central hub node (filled) */}
      <circle cx={120} cy={120} r={13} fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} />

      {/* outer outline nodes */}
      <circle cx={76} cy={72} r={8} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      <circle cx={176} cy={74} r={8} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      <circle cx={184} cy={138} r={8} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      <circle cx={128} cy={184} r={8} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      <circle cx={54} cy={148} r={8} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}
