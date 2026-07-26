export function EmptyReports({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Person holding a clean, empty clipboard ledger"
    >
      {/* soft background blob */}
      <circle cx="120" cy="116" r="85" fill="var(--color-accent)" fillOpacity={0.15} />

      {/* floor shadow */}
      <ellipse cx="120" cy="208" rx="64" ry="9" fill="var(--color-accent)" fillOpacity={0.15} />

      {/* ambient details */}
      <circle cx="58" cy="150" r="3.5" fill="var(--color-accent)" />
      <path d="M188 70l2.5 7 7 2.5-7 2.5-2.5 7-2.5-7-7-2.5 7-2.5z" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="62" cy="66" r="3" stroke="currentColor" strokeWidth={2} />

      {/* person: head */}
      <circle cx="96" cy="72" r="17" stroke="currentColor" strokeWidth={2} fill="none" />
      {/* hair */}
      <path d="M79 70c-1-12 8-21 17-21s18 9 17 21c-3-6-8-8-12-8-3 5-11 4-15 0-3 1-6 3-7 8z" fill="var(--color-accent)" />
      {/* calm face */}
      <path d="M90 74a1.8 1.8 0 100 .01M102 74a1.8 1.8 0 100 .01" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M92 82c2 1.5 6 1.5 8 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* torso / garment (accent) */}
      <path d="M76 176c-2-24 4-45 20-45s22 21 20 45z" fill="var(--color-accent)" />
      <path d="M90 89v8M102 89v8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* legs */}
      <path d="M88 176l-4 24M104 176l4 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M76 200h14M102 200h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* left arm cradling clipboard */}
      <path d="M80 132c-6 5-9 13-8 22" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      {/* right arm reaching over the clipboard */}
      <path d="M114 132c10 2 18 8 22 18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* clipboard / empty ledger */}
      <rect x="118" y="120" width="54" height="70" rx="6" fill="var(--color-accent)" />
      <rect x="118" y="120" width="54" height="70" rx="6" stroke="currentColor" strokeWidth={2} fill="none" />
      {/* inner clean page */}
      <rect x="126" y="130" width="38" height="52" rx="3" stroke="currentColor" strokeWidth={2} strokeOpacity={0.7} fill="none" />
      {/* clip at top */}
      <rect x="136" y="114" width="18" height="10" rx="3" stroke="currentColor" strokeWidth={2} fill="none" />
      {/* empty ruled lines (faint dashes = nothing logged) */}
      <path d="M133 144h24M133 154h24M133 164h18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeOpacity={0.4} strokeDasharray="1 8" />
    </svg>
  );
}
