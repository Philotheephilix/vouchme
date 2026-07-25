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
    <div className="border border-protest px-4 py-3" style={{ borderColor: "var(--color-protest)" }}>
      <p className="text-sm leading-relaxed text-cream">
        <span className="font-mono" style={{ color: "var(--color-protest)" }}>
          ⚠
        </span>{" "}
        If {possessive(link.voucherEnsName)} vouch expires you drop to{" "}
        <span className="font-mono" style={{ color: "var(--color-protest)" }}>
          {fmtScore(link.scoreIfExpired)}
        </span>{" "}
        and lose <span className="font-mono text-cream">{tierLabel(link.currentTier)}</span>.
      </p>
    </div>
  );
}
