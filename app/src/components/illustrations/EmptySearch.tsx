export function EmptySearch({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Person holding a magnifying glass over an empty area, nothing found"
    >
      {/* soft background blob */}
      <circle cx="118" cy="116" r="86" fill="var(--color-accent)" fillOpacity={0.15} />

      {/* floor shadow */}
      <ellipse cx="118" cy="208" rx="64" ry="9" fill="var(--color-accent)" fillOpacity={0.15} />

      {/* ambient details */}
      <path d="M52 78l2.5 7 7 2.5-7 2.5-2.5 7-2.5-7-7-2.5 7-2.5z" fill="var(--color-accent)" />
      <circle cx="196" cy="150" r="3.5" stroke="currentColor" strokeWidth={2} />
      <circle cx="182" cy="70" r="3" fill="var(--color-accent)" />

      {/* empty search field being scanned */}
      <rect x="112" y="150" width="66" height="16" rx="8" stroke="currentColor" strokeWidth={2} strokeOpacity={0.5} strokeDasharray="2 7" fill="none" />

      {/* person: head */}
      <circle cx="82" cy="72" r="17" stroke="currentColor" strokeWidth={2} fill="none" />
      {/* hair */}
      <path d="M65 70c-1-12 8-21 17-21s18 9 17 21c-3-6-8-8-12-8-3 5-11 4-15 0-3 1-6 3-7 8z" fill="var(--color-accent)" />
      {/* face */}
      <path d="M76 74a1.8 1.8 0 100 .01M88 74a1.8 1.8 0 100 .01" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M79 82c2 1.5 6 1.5 8 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* torso / garment (accent) */}
      <path d="M62 174c-2-24 4-45 20-45s22 21 20 45z" fill="var(--color-accent)" />
      <path d="M76 89v8M88 89v8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* legs */}
      <path d="M74 174l-4 24M90 174l4 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M62 198h14M88 198h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* left arm resting */}
      <path d="M66 132c-6 4-9 9-10 16" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* right arm reaching to hold the magnifier handle */}
      <path d="M100 130c9 4 16 11 20 20" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* large magnifying glass */}
      <circle cx="150" cy="100" r="30" fill="var(--color-accent)" />
      <circle cx="150" cy="100" r="30" stroke="currentColor" strokeWidth={2} fill="none" />
      <circle cx="150" cy="100" r="22" stroke="currentColor" strokeWidth={2} strokeOpacity={0.6} fill="none" />
      {/* lens highlight */}
      <path d="M138 90c2-4 6-7 11-7" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeOpacity={0.7} />
      {/* handle */}
      <path d="M172 122l18 18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M188 138l6 6" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
