export function Header({ eyebrow, title }: { eyebrow: string; title?: string }) {
  return (
    <header className="sticky top-0 z-30 bg-void" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <div className="border-b border-rule px-4 py-3">
        <div className="font-mono text-2xs uppercase tracking-widest text-graphite">AVAL · {eyebrow}</div>
        {title ? <div className="truncate-mono mt-0.5 text-sm text-cream">{title}</div> : null}
      </div>
    </header>
  );
}
