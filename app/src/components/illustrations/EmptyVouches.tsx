export function EmptyVouches({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Person standing beside an empty list with a hopeful seedling"
    >
      {/* soft background blob */}
      <circle cx="122" cy="116" r="84" fill="var(--color-accent)" fillOpacity={0.15} />

      {/* floor shadow */}
      <ellipse cx="120" cy="208" rx="66" ry="9" fill="var(--color-accent)" fillOpacity={0.15} />

      {/* ambient details */}
      <circle cx="56" cy="70" r="3.5" fill="var(--color-accent)" />
      <path d="M186 62l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* empty list card */}
      <rect x="140" y="66" width="58" height="78" rx="6" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" fill="none" />
      <path d="M150 82h20M150 96h38M150 110h30M150 124h34" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeOpacity={0.5} strokeDasharray="1 8" />
      {/* faint empty-state dash line */}
      <path d="M152 66v78" stroke="var(--color-accent)" strokeWidth={2} strokeOpacity={0.4} />

      {/* person: head */}
      <circle cx="86" cy="78" r="17" stroke="currentColor" strokeWidth={2} fill="none" />
      {/* hair */}
      <path d="M69 76c-1-12 8-21 17-21s18 9 17 21c-3-6-8-8-12-8-3 5-11 4-15 0-3 1-6 3-7 8z" fill="var(--color-accent)" />
      {/* hopeful face */}
      <path d="M80 80a1.8 1.8 0 100 .01M92 80a1.8 1.8 0 100 .01" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M82 87c2 2 6 2 8 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* torso / garment (accent) */}
      <path d="M66 178c-2-24 4-46 20-46s22 22 20 46z" fill="var(--color-accent)" />
      <path d="M80 95v8M92 95v8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* legs */}
      <path d="M78 178l-4 24M94 178l4 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M66 202h14M92 202h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* arms */}
      <path d="M70 136c-6 4-10 10-11 18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M102 136c8 3 14 9 16 18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* seedling in a pot */}
      <path d="M100 200l4-18h22l4 18z" fill="var(--color-accent)" />
      <path d="M100 200h34" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M115 182v-18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M115 168c-2-8-9-9-13-8 1 8 7 11 13 8z" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" fill="none" />
      <path d="M115 172c2-7 9-8 13-6-1 7-7 9-13 6z" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" fill="none" />
    </svg>
  );
}
