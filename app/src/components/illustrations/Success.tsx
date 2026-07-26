export function Success({ size = 220, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 240 240"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      role="img"
      aria-label="Person celebrating with a verified identity card"
    >
      {/* soft background blob */}
      <circle cx="120" cy="118" r="86" fill="var(--color-accent)" fillOpacity={0.15} />

      {/* floor shadow */}
      <ellipse cx="120" cy="206" rx="62" ry="9" fill="var(--color-accent)" fillOpacity={0.15} />

      {/* ambient sparkles */}
      <path d="M46 66l3 8 8 3-8 3-3 8-3-8-8-3 8-3z" fill="var(--color-accent)" />
      <path d="M196 96l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="58" cy="150" r="3.5" fill="var(--color-accent)" />
      <circle cx="188" cy="52" r="3" stroke="currentColor" strokeWidth={2} />

      {/* head */}
      <circle cx="120" cy="70" r="18" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
      {/* hair */}
      <path d="M102 66c-1-13 9-22 18-22s19 8 18 22c-3-5-8-7-13-7-3 5-13 4-16 0-3 1-6 3-7 7z" fill="var(--color-accent)" />
      {/* face hint */}
      <path d="M113 72a2 2 0 100 .01M127 72a2 2 0 100 .01" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M115 79c2 2.5 8 2.5 10 0" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* torso / shirt (accent garment) */}
      <path d="M100 176c-2-24 4-46 20-46s22 22 20 46z" fill="var(--color-accent)" />
      {/* neck */}
      <path d="M114 86v8M126 86v8" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />

      {/* legs */}
      <path d="M111 176l-4 24M129 176l4 24" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M99 200h14M127 200h14" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* raised left arm */}
      <path d="M104 132c-10-6-18-16-20-30" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="83" cy="99" r="4" stroke="currentColor" strokeWidth={2} />

      {/* right arm presenting the card */}
      <path d="M136 130c9-2 17-6 24-10" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />

      {/* verified identity card */}
      <rect x="156" y="96" width="52" height="36" rx="5" fill="var(--color-accent)" />
      <circle cx="169" cy="110" r="6" stroke="currentColor" strokeWidth={2} fill="none" />
      <path d="M182 106h18M182 113h14M182 120h20" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      {/* check badge on card */}
      <circle cx="200" cy="122" r="9" fill="currentColor" />
      <path d="M196 122l3 3 5-6" stroke="var(--color-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
