export function StatLine({
  label,
  value,
  hint,
  valueColor,
}: {
  label: string;
  value: string;
  hint?: string;
  valueColor?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule py-2.5 last:border-b-0">
      <span className="text-sm text-graphite">{label}</span>
      <span className="text-right">
        <span className="font-mono text-sm font-medium text-cream" style={valueColor ? { color: valueColor } : undefined}>
          {value}
        </span>
        {hint ? <span className="mt-0.5 block font-mono text-2xs text-graphite">{hint}</span> : null}
      </span>
    </div>
  );
}
