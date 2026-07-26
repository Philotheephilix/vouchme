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
      aria-label="A person tending a growing plant over time"
    >
      {/* soft background blob */}
      <circle cx="120" cy="120" r="94" fill="var(--color-accent)" fillOpacity={0.15} />

      {/* --- Person kneeling / tending on the left --- */}
      <circle cx="74" cy="72" r="15" fill="none" stroke="currentColor" strokeWidth={2} />
      <path d="M61 68 Q64 54 78 57 Q87 59 87 70" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M72 74 q3 3 6 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* torso / shirt (accent garment) */}
      <path
        d="M50 138 Q48 100 74 100 Q100 100 104 132 L96 146 Q72 154 54 146 Z"
        fill="var(--color-accent)"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {/* caring arm reaching toward the plant */}
      <path d="M98 126 Q122 128 134 142" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M132 140 q9 -1 11 8 q-6 5 -11 1 Z" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

      {/* --- Pot --- */}
      <path
        d="M138 170 L182 170 L176 202 L144 202 Z"
        fill="var(--color-accent)"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path d="M134 170 L186 170" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* --- Sprout growing taller --- */}
      <path d="M160 168 L160 120" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      {/* left leaf */}
      <path d="M160 140 Q142 138 138 122 Q156 122 160 140 Z" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      {/* right leaf */}
      <path d="M160 128 Q178 124 184 108 Q164 110 160 128 Z" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      {/* top bud */}
      <path d="M160 120 q-8 -12 0 -18 q8 6 0 18 Z" fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

      {/* --- Upward growth curve (tenure over time) --- */}
      <path d="M52 178 Q78 172 100 154 Q116 140 122 118" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeDasharray="1 7" />

      {/* ambient sparkle + dots */}
      <path d="M198 78 l0 10 M193 83 l10 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <circle cx="196" cy="150" r="2.5" fill="var(--color-accent)" />
      <circle cx="46" cy="96" r="2.5" fill="var(--color-accent)" />
    </svg>
  );
}
