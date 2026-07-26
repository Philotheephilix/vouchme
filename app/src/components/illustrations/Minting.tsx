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
      aria-label="Person watching an identity card being minted on chain"
    >
      {/* soft background blob */}
      <circle cx={124} cy={100} r={78} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* floor shadow */}
      <ellipse cx={112} cy={216} rx={72} ry={9} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* ambient dots */}
      <circle cx={48} cy={64} r={3} fill="var(--color-accent)" />
      <circle cx={200} cy={172} r={2.5} fill="var(--color-accent)" />

      {/* sparkles around the rising card */}
      <path d="M150 44l4 8 8 4-8 4-4 8-4-8-8-4 8-4 4-8Z" fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <path d="M188 96l2 5 5 2-5 2-2 5-2-5-5-2 5-2 2-5Z" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <path d="M112 40l3 3M115 40l-3 3" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* ---- rising identity card ---- */}
      {/* motion lines under card */}
      <path d="M156 128l-4 12M172 128l2 12M188 128l6 10" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <rect x={144} y={70} width={56} height={40} rx={6} fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      {/* avatar dot on card */}
      <circle cx={158} cy={84} r={6} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      {/* handle lines on card */}
      <path d="M170 82h20M170 90h14M152 100h36" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* progress bar under scene */}
      <rect x={140} y={150} width={64} height={8} rx={4} stroke="currentColor" strokeWidth={2} fill="none" />
      <rect x={140} y={150} width={40} height={8} rx={4} fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

      {/* ---- person watching ---- */}
      {/* head, looking up */}
      <circle cx={80} cy={78} r={16} stroke="currentColor" strokeWidth={2} />
      {/* hair */}
      <path d="M65 76c-2-12 6-21 15-21 9 0 16 6 16 15-4-4-10-6-16-6-6 0-11 4-15 12Z" fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      {/* face hint (looking up toward card) */}
      <path d="M84 74v2M88 82c-2 2-6 2-8 1" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      {/* neck */}
      <path d="M74 92v8M86 92v8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* torso / shirt (accent) */}
      <path d="M60 110c1-8 8-14 20-14s19 6 20 14l4 44c0 3-2 5-5 5H61c-3 0-5-2-5-5l4-44Z" fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

      {/* legs */}
      <path d="M72 158l-6 50M98 158l6 50" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M60 210h14M102 210h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* arms, both raised toward card */}
      <path d="M100 116c14 0 26-8 38-16" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M62 116c-4 8-3 17 2 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
