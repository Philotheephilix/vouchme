import { fmtScore, tierLabel } from "@/lib/format";
import type { WeakestLink as WeakestLinkT } from "@/lib/types";

function possessive(ensName: string): string {
  const [first] = ensName.split(".");
  const name = first ? first[0]!.toUpperCase() + first.slice(1) : ensName;
  return `${name}'s`;
}

export function WeakestLink({ link }: { link: WeakestLinkT }) {
  if (!link.losesTier) return null;
  return (
    <div
      className="rounded-[10px] border border-protest/40 p-4"
      style={{ backgroundColor: "var(--color-protest-subtle)" }}
    >
      <div className="eyebrow mb-1.5 text-protest">Weakest link</div>
      <p className="text-sm leading-relaxed text-cream">
        If {possessive(link.voucherEnsName)} vouch expires you drop to{" "}
        <span className="font-mono font-medium text-protest">{fmtScore(link.scoreIfExpired)}</span> and lose{" "}
        <span className="font-mono font-medium">{tierLabel(link.currentTier)}</span>.
      </p>
    </div>
  );
}
