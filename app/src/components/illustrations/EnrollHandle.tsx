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
      aria-label="A rounded nameplate tag with a blinking cursor line, a handle being entered"
    >
      {/* soft background blob */}
      <circle cx={120} cy={120} r={82} fill="var(--color-accent)" fillOpacity={0.15} />

      {/* the nameplate / handle tag */}
      <rect x={56} y={92} width={128} height={56} rx={14} fill="var(--color-paper)" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" />

      {/* typed handle underscore + cursor */}
      <path d="M78 130h44" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
      <path d="M134 112v22" stroke="currentColor" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}
