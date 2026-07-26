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
      aria-label="A person standing beside a glowing anchor orb"
    >
      {/* soft background blob */}
      <circle cx="120" cy="120" r="94" fill="var(--color-accent)" fillOpacity={0.15} />

      {/* --- The glowing Orb / anchor ring (right) --- */}
      <circle cx="158" cy="112" r="42" fill="var(--color-accent)" fillOpacity={0.15} />
      <circle cx="158" cy="112" r="42" fill="none" stroke="currentColor" strokeWidth={2} />
      <circle cx="158" cy="112" r="30" fill="none" stroke="currentColor" strokeWidth={2} />
      {/* radiant core */}
      <circle cx="158" cy="112" r="12" fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} />

      {/* radiating beams */}
      <path d="M158 58 l0 -12" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M158 178 l0 12" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M212 112 l12 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M196 74 l9 -9" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M196 150 l9 9" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* --- Person standing beside the orb (left) --- */}
      <circle cx="70" cy="76" r="15" fill="none" stroke="currentColor" strokeWidth={2} />
      <path d="M57 72 Q60 58 74 61 Q83 63 83 74" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M68 78 q3 3 6 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* torso / shirt (accent garment) */}
      <path
        d="M50 156 Q48 104 70 104 Q92 104 92 156 Z"
        fill="var(--color-accent)"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {/* arm reaching toward the orb */}
      <path d="M90 128 Q108 122 120 116" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M118 114 q9 -2 11 6 q-5 6 -11 2 Z" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

      {/* legs */}
      <path d="M62 156 L60 190" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M80 156 L82 190" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* floor shadow (accent) */}
      <ellipse cx="118" cy="200" rx="72" ry="8" fill="var(--color-accent)" fillOpacity={0.15} />

      {/* ambient sparkle + dots */}
      <path d="M120 52 l0 10 M115 57 l10 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <circle cx="196" cy="176" r="2.5" fill="var(--color-accent)" />
      <circle cx="40" cy="120" r="2.5" fill="var(--color-accent)" />
    </svg>
  );
}
