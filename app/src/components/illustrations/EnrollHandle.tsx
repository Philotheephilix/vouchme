export function EnrollHandle({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Person seated at a desk choosing a handle name"
    >
      {/* soft background blob */}
      <circle cx={112} cy={100} r={76} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* floor shadow */}
      <ellipse cx={124} cy={216} rx={70} ry={9} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* ambient dots + sparkle */}
      <circle cx={192} cy={70} r={3} fill="var(--color-accent)" />
      <circle cx={54} cy={54} r={2.5} fill="var(--color-accent)" />
      <path d="M188 128l3 3M191 128l-3 3" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* floating name-tag / handle field */}
      <rect x={140} y={44} width={70} height={30} rx={8} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <path d="M150 59h6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <rect x={160} y={53} width={30} height={12} rx={2} fill="var(--color-accent)" fillOpacity={0.15} stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      {/* blinking cursor in field */}
      <path d="M164 55v8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M150 74l-6 8h10l-4-8Z" fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

      {/* ---- desk ---- */}
      <path d="M60 176h140" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M74 176v34M186 176v34" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* laptop on desk */}
      <path d="M120 176l6-24h34l6 24" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <rect x={126} y={130} width={34} height={24} rx={3} fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <path d="M132 138h14M132 144h20" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* ---- person seated ---- */}
      {/* head */}
      <circle cx={92} cy={68} r={16} stroke="currentColor" strokeWidth={2} />
      {/* hair */}
      <path d="M77 66c-2-12 6-21 15-21 9 0 16 6 17 15-4-4-10-6-16-6-6 0-12 4-16 12Z" fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      {/* face hint */}
      <path d="M88 70c1.5 1.5 3 2 5 2M99 66v2" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      {/* neck */}
      <path d="M86 82v8M98 82v8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* torso / shirt (accent) */}
      <path d="M74 100c1-8 8-14 18-14s17 6 18 14l3 40c0 3-2 4-4 4H75c-2 0-4-1-4-4l3-40Z" fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

      {/* seated legs */}
      <path d="M76 148v20h34M110 148l-2 20" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M110 168l24 8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* arms reaching to laptop */}
      <path d="M108 108c14 4 22 12 24 22" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M78 108c-6 6-8 14-6 22 6 4 14 4 22-1" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* chair back */}
      <path d="M66 108v58" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}
