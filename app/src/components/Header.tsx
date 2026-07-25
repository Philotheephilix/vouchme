import { truncateMiddle } from "@/lib/format";
import { AccountControl } from "./AccountControl";

export function Header({ eyebrow, title }: { eyebrow: string; title?: string }) {
  return (
    <header className="sticky top-0 z-30 bg-void" style={{ paddingTop: "env(safe-area-inset-top)" }}>
      <div className="flex items-start justify-between gap-3 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <div className="font-mono text-2xs uppercase tracking-widest text-graphite">VOUCHME · {eyebrow}</div>
          {title ? <div className="truncate-mono mt-0.5 text-sm text-cream">{truncateMiddle(title, 34)}</div> : null}
        </div>
        <AccountControl />
      </div>
    </header>
  );
}
