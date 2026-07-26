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
      aria-label="People connected in a trust graph"
    >
      {/* soft background blob */}
      <circle cx="120" cy="122" r="94" fill="var(--color-accent)" fillOpacity={0.15} />

      {/* trust edges between the three people */}
      <path d="M78 92 L162 92" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M78 92 L120 172" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M162 92 L120 172" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* edge midpoint node dots (accent) */}
      <circle cx="120" cy="92" r="3.5" fill="var(--color-accent)" />
      <circle cx="99" cy="132" r="3.5" fill="var(--color-accent)" />
      <circle cx="141" cy="132" r="3.5" fill="var(--color-accent)" />

      {/* --- Person A (top-left node) --- */}
      <circle cx="78" cy="82" r="10" fill="none" stroke="currentColor" strokeWidth={2} />
      <path d="M72 76 Q78 70 84 76" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M62 108 Q62 92 78 92 Q94 92 94 108 Z"
        fill="var(--color-accent)"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {/* --- Person B (top-right node) --- */}
      <circle cx="162" cy="82" r="10" fill="none" stroke="currentColor" strokeWidth={2} />
      <path d="M156 76 Q162 70 168 76" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M146 108 Q146 92 162 92 Q178 92 178 108 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {/* --- Person C (bottom node) --- */}
      <circle cx="120" cy="162" r="11" fill="none" stroke="currentColor" strokeWidth={2} />
      <path d="M113 155 Q120 148 127 155" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M101 190 Q101 172 120 172 Q139 172 139 190 Z"
        fill="var(--color-accent)"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinejoin="round"
      />

      {/* ambient sparkle + floating dots */}
      <path d="M196 62 l0 10 M191 67 l10 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <circle cx="46" cy="150" r="2.5" fill="var(--color-accent)" />
      <circle cx="198" cy="152" r="2.5" fill="var(--color-accent)" />
    </svg>
  );
}
