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
      aria-label="Person holding a phone showing a trust graph"
    >
      {/* soft background blob */}
      <circle cx={132} cy={104} r={74} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* floor shadow */}
      <ellipse cx={116} cy={214} rx={62} ry={9} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* ambient floating dots */}
      <circle cx={46} cy={64} r={3} fill="var(--color-accent)" />
      <circle cx={200} cy={150} r={2.5} fill="var(--color-accent)" />
      <path d="M198 60l3 3M201 60l-3 3" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* plant */}
      <path d="M40 214v-26" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M40 194c-8-2-15-9-15-18 9 1 16 8 15 18Z" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M40 200c8-3 15-11 15-21-9 1-17 10-15 21Z" fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M33 214h14l-2 8H35l-2-8Z" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* ---- person ---- */}
      {/* head */}
      <circle cx={104} cy={58} r={16} stroke="currentColor" strokeWidth={2} />
      {/* hair */}
      <path d="M89 55c-1-11 7-19 16-19 8 0 15 5 16 14-5-3-11-4-17-3-5 1-11 4-15 8Z" fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      {/* face hint */}
      <path d="M99 60c1 1.5 2.5 2.5 4 2.5M110 57v2" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* torso / shirt (accent garment) */}
      <path d="M86 96c1-9 8-16 18-16s17 7 18 16l4 44c0 3-2 5-5 5H87c-3 0-5-2-5-5l4-44Z" fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      {/* neck */}
      <path d="M98 73v9M110 73v9" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* legs */}
      <path d="M92 150l-6 52M116 150l6 52" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M80 204h14M118 204h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* left arm resting */}
      <path d="M88 104c-8 6-12 15-11 25" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {/* right arm raised holding phone */}
      <path d="M120 102c12 2 22-6 28-18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* phone held up */}
      <rect x={142} y={54} width={40} height={62} rx={7} fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <rect x={148} y={62} width={28} height={46} rx={3} stroke="currentColor" strokeWidth={2} fill="none" />
      {/* hand gripping phone */}
      <path d="M148 100c-4 3-6 8-4 13 3 2 8 2 12-1" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* trust graph on screen */}
      <path d="M162 72l-8 12M162 72l9 9M154 84l8 9M171 81l-9 12" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <circle cx={162} cy={72} r={3.5} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      <circle cx={154} cy={84} r={3} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      <circle cx={171} cy={81} r={3} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      <circle cx={162} cy={93} r={3} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
    </svg>
  );
}
