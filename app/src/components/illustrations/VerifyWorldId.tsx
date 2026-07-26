export function VerifyWorldId({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Person facing an orb for World ID identity scan"
    >
      {/* soft background blob */}
      <circle cx={122} cy={104} r={78} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* floor shadow */}
      <ellipse cx={118} cy={216} rx={72} ry={9} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* ambient dots + sparkle */}
      <circle cx={44} cy={70} r={3} fill="var(--color-accent)" />
      <circle cx={206} cy={168} r={2.5} fill="var(--color-accent)" />
      <path d="M46 168l3 3M49 168l-3 3" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* ---- the orb ---- */}
      <circle cx={170} cy={100} r={40} fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} />
      {/* orb ring / face-in-circle motif */}
      <circle cx={170} cy={100} r={40} stroke="currentColor" strokeWidth={2} strokeDasharray="3 6" fill="none" />
      <circle cx={170} cy={100} r={16} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />
      {/* face inside orb */}
      <path d="M164 98v3M176 98v3M165 106c2 3 8 3 10 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      {/* orb stand */}
      <path d="M170 140v34M156 174h28" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* scan lines from orb to face */}
      <path d="M132 88l18-4M132 100h16M132 112l18 4" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* ---- person facing orb ---- */}
      {/* head, in profile facing right */}
      <circle cx={82} cy={72} r={16} stroke="currentColor" strokeWidth={2} />
      {/* hair */}
      <path d="M67 70c-2-12 5-21 15-21 6 0 11 3 14 8-6-2-13-1-19 3-4 3-8 6-10 10Z" fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      {/* face hint facing orb */}
      <path d="M92 70v2M88 78c3 2 6 2 8 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      {/* scan reticle over face */}
      <path d="M74 60l-6-2M74 60l-2-6M90 60l6-2M90 60l2-6M74 88l-6 2M74 88l-2 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      {/* neck */}
      <path d="M78 86v8M90 86v8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* torso / shirt (accent) */}
      <path d="M62 104c1-8 8-14 20-14s19 6 20 14l4 44c0 3-2 5-5 5H63c-3 0-5-2-5-5l4-44Z" fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

      {/* legs */}
      <path d="M74 152l-6 52M100 152l6 52" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M62 206h14M104 206h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* arms, one reaching toward orb */}
      <path d="M100 110c12 0 22 2 28 8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M66 110c-6 6-8 15-6 25" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
