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
      aria-label="A person signing their name on the line"
    >
      {/* soft background blob */}
      <circle cx="120" cy="120" r="94" fill="var(--color-accent)" fillOpacity={0.15} />

      {/* --- Figure (upper body, leaning to sign) --- */}
      <circle cx="86" cy="70" r="15" fill="none" stroke="currentColor" strokeWidth={2} />
      {/* hair hint */}
      <path d="M73 66 Q76 52 90 55 Q99 57 99 68" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {/* face hint */}
      <path d="M84 72 q3 3 6 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* torso / shirt (accent garment) */}
      <path
        d="M62 132 Q60 96 86 96 Q112 96 116 126 L110 138 Q90 146 70 140 Z"
        fill="var(--color-accent)"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {/* signing arm reaching toward the line */}
      <path
        d="M110 122 Q136 130 150 150"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
      />
      {/* hand */}
      <path d="M148 148 q10 -2 12 8 q-6 6 -12 2 Z" fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

      {/* --- Pen held in hand --- */}
      <path d="M160 156 L188 132" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M186 130 l8 -7 4 6 -7 8 Z" fill="var(--color-accent)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />
      <path d="M158 158 l4 4" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* --- Signature line + inked signature (the aval) --- */}
      <path d="M96 186 L196 186" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path
        d="M108 180 q6 -12 12 0 q4 8 12 -2 q6 -6 12 2 q4 6 10 -2"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* the "X" mark anchoring the line */}
      <path d="M98 190 l6 6 M104 190 l-6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* ambient sparkle + dot */}
      <path d="M186 66 l0 10 M181 71 l10 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <circle cx="52" cy="168" r="2.5" fill="var(--color-accent)" />
    </svg>
  );
}
