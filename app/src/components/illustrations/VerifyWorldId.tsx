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
      aria-label="An iris ring with a checkmark inside, an identity verified"
    >
      {/* soft background blob */}
      <circle cx={120} cy={120} r={82} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* the iris ring */}
      <circle cx={120} cy={120} r={52} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} />

      {/* checkmark inside, verified */}
      <path d="M100 121l14 16 26-32" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
