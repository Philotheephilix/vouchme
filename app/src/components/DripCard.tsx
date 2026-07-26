"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { encodeFunctionData } from "viem";
import { fmtVouchMe, fmtDays, fmtScore } from "@/lib/format";
import type { Address, PresenceState } from "@/lib/types";
import { activeMiniKit, inWorldAppNow, useAuth } from "@/lib/session";
import { PRESENCE_DRIP_ABI, WORLDCHAIN_ID, explorerTxUrl, getPresenceDripAddress } from "@/lib/worldchain";
import { decodeRevertReason, ensureWorldChainSepolia, submitFromInjected } from "@/lib/wallet";

/**
 * The daily rate, the accrued figure, a hairline countdown to the 30-day cap, and the tenure curve
 * flattening toward a dashed ceiling. The flattening is the point — docs/16-presence-drip.md §4.1:
 * presence alone can never promote anyone.
 *
 * `Claim` is real: it fetches a tier attestation from `/api/presence/attest`, sends
 * `PresenceDrip.claim(...)` from the connected wallet, and refreshes the server-rendered accrued
 * figure once the transaction confirms. Only enabled when `canClaim` — i.e. this card shows the
 * signed-in viewer's own presence, not a demo identity's.
 */
export function DripCard({ presence, address, canClaim }: { presence: PresenceState; address: Address; canClaim: boolean }) {
  const auth = useAuth();
  const router = useRouter();
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // A World App UserOperation hash is not a transaction hash — `worldscan.org/tx/…` does not
  // resolve one, so it must never be rendered as an explorer link.
  const [txIsUserOp, setTxIsUserOp] = useState(false);

  const claimedFraction = Math.min(1, Math.max(0, (presence.maxUnclaimedDays - presence.daysUntilCap) / presence.maxUnclaimedDays));
  const claimedPct = claimedFraction * 100;

  async function handleClaim() {
    if (!auth.address) return;
    setClaiming(true);
    setClaimError(null);
    setTxHash(null);
    try {
      const res = await fetch("/api/presence/attest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: auth.address }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body?.error?.message ?? "Could not prepare a claim attestation.");
      const { tier, deadline, nonce, attestation } = body.data as { tier: number; deadline: string; nonce: string; attestation: `0x${string}` };

      const data = encodeFunctionData({
        abi: PRESENCE_DRIP_ABI,
        functionName: "claim",
        args: [tier, BigInt(deadline), BigInt(nonce), attestation],
      });
      const dripAddress = getPresenceDripAddress();

      // Host check rather than `MiniKit.isInstalled()`: the latter reads a per-module-copy flag that
      // can be false in a healthy World App session (src/lib/session.tsx `activeMiniKit`).
      if (inWorldAppNow()) {
        const result = await activeMiniKit().sendTransaction({ transactions: [{ to: dripAddress, data }], chainId: WORLDCHAIN_ID });
        setTxHash(result.data.userOpHash);
        setTxIsUserOp(true);
      } else {
        await ensureWorldChainSepolia();
        const outcome = await submitFromInjected(auth.address, dripAddress, data);
        setTxHash(outcome.hash);
        setTxIsUserOp(false);
        if (outcome.status !== "success") throw new Error(outcome.revertReason ?? "Transaction reverted.");
      }
      router.refresh(); // re-fetches the server-rendered accrued figure from the now-updated chain state
    } catch (err) {
      setClaimError(decodeRevertReason(err));
    } finally {
      setClaiming(false);
    }
  }

  // Colour-forward hero card: a deep brand-blue drip that sits directly under the face, so the one
  // thing you can *earn* every day is the second thing you see. White/translucent text throughout;
  // the accrued figure is the loudest number on the page after the score itself. The surface is lit
  // — a soft light source top-left and a deeper pool bottom-right give the flat blue real depth,
  // and the header dot pulses because the drip is literally accruing while you look at it.
  const faint = "rgba(255,255,255,0.74)";
  const track = "rgba(255,255,255,0.20)";
  const canClaimNow = canClaim && !claiming && presence.accruedVouchMe > 0;

  return (
    <div
      data-testid="drip-card"
      className="anim-rise-sm relative overflow-hidden p-5"
      style={{
        borderRadius: "var(--radius-xl)",
        background:
          "radial-gradient(130% 100% at 12% -10%, rgba(255,255,255,0.16), transparent 52%)," +
          "radial-gradient(110% 90% at 100% 112%, rgba(9,19,110,0.62), transparent 60%)," +
          "linear-gradient(158deg,#2c46e6 0%,#2135c8 55%,#16279e 100%)",
        color: "#fff",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2), 0 24px 44px -30px rgba(22,39,158,0.9)",
      }}
    >
      <div className="flex items-center justify-between">
        <span className="eyebrow inline-flex items-center gap-1.5" style={{ color: "rgba(255,255,255,0.78)" }}>
          <span className="dot dot-pulse" style={{ background: "#fff" }} aria-hidden />
          Presence drip
        </span>
        <span
          className="font-mono text-2xs font-medium"
          style={{ color: "#fff", background: track, padding: "3px 10px", borderRadius: 999, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.12)" }}
        >
          {presence.tierRatePct}% rate
        </span>
      </div>

      <div className="mt-5 flex items-end justify-between gap-4">
        <div>
          <div className="flex items-baseline gap-1">
            <span
              className="font-mono"
              style={{ fontSize: "clamp(38px, 12.5vw, 46px)", fontWeight: 700, lineHeight: 0.9, letterSpacing: "-0.035em", textShadow: "0 2px 18px rgba(20,15,60,0.28)" }}
            >
              {presence.accruedVouchMe.toFixed(1)}
            </span>
            <span className="font-mono text-sm font-medium" style={{ color: faint }}>
              VM
            </span>
          </div>
          <div className="mt-2 font-mono text-2xs" style={{ color: faint }}>
            accrued · {fmtVouchMe(presence.dailyRateVouchMe)}/day
          </div>
        </div>
        <button
          type="button"
          data-testid="drip-claim"
          onClick={() => void handleClaim()}
          disabled={!canClaimNow}
          title={!canClaim ? "Sign in to claim your own drip." : undefined}
          className="btn shrink-0"
          style={
            canClaimNow
              ? { background: "#fff", color: "#2135c8", boxShadow: "0 10px 22px -12px rgba(20,15,60,0.55)" }
              : // disabled on the blue card: a translucent white chip, not the muddy default gray
                { background: "rgba(255,255,255,0.22)", color: "rgba(255,255,255,0.6)", boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.28)" }
          }
        >
          {claiming ? "Claiming…" : "Claim"}
        </button>
      </div>

      {claimError ? (
        <p className="mt-2 text-2xs" style={{ color: "#ffd9e0" }} data-testid="drip-claim-error">
          {claimError}
        </p>
      ) : null}
      {txHash && !txIsUserOp ? (
        <a href={explorerTxUrl(txHash)} target="_blank" rel="noreferrer" className="truncate-mono mt-2 block font-mono text-2xs underline" style={{ color: "#fff" }}>
          {txHash}
        </a>
      ) : null}
      {txHash && txIsUserOp ? (
        <p className="truncate-mono mt-2 font-mono text-2xs" style={{ color: faint }}>
          user operation {txHash} — submitted to World App&apos;s bundler; the accrued figure updates once it is
          mined.
        </p>
      ) : null}

      <div className="mt-6">
        <div className="mb-1.5 flex items-baseline justify-between text-2xs">
          <span style={{ color: faint }}>Claim window</span>
          <span className="font-mono" style={{ color: "#fff" }}>
            {fmtDays(presence.daysUntilCap)} until cap · {presence.maxUnclaimedDays}d
          </span>
        </div>
        <div className="relative h-2 w-full overflow-hidden rounded-full" style={{ backgroundColor: track }}>
          <div
            className="absolute left-0 top-0 h-full rounded-full"
            style={{
              width: `${Math.max(claimedPct, 2)}%`,
              background: "linear-gradient(90deg, rgba(255,255,255,0.85), #fff)",
              boxShadow: "0 0 10px rgba(255,255,255,0.55)",
            }}
          />
        </div>
      </div>

      <div className="mt-6 border-t pt-4" style={{ borderColor: "rgba(255,255,255,0.16)" }}>
        <div className="mb-2 flex items-baseline justify-between">
          {/* `epochsClaimed` only advances when you claim, so this is presence CREDITED on chain,
              not time elapsed since enrolling. */}
          <span className="text-2xs" style={{ color: faint }}>Credited {presence.presentDays}d</span>
          <span className="font-mono text-sm font-medium" style={{ color: "#fff" }}>tenure +{fmtScore(presence.tenureBonus)}</span>
        </div>
        <TenureCurve presence={presence} line="rgba(255,255,255,0.95)" ceiling="rgba(255,255,255,0.3)" fill="rgba(255,255,255,0.16)" />
        <div className="mt-1 text-right font-mono text-2xs" style={{ color: faint }}>max +{presence.tenureMaxBonus.toFixed(2)}</div>
      </div>
    </div>
  );
}

function TenureCurve({
  presence,
  line = "var(--color-seal)",
  ceiling = "var(--color-rule)",
  fill,
}: {
  presence: PresenceState;
  line?: string;
  ceiling?: string;
  fill?: string;
}) {
  const width = 280;
  const height = 56;
  const top = 5;
  const bottom = height - 4;
  const maxDays = presence.curve.length > 0 ? presence.curve[presence.curve.length - 1]!.days : 1;
  const maxTenure = Math.max(presence.tenureMaxBonus, ...presence.curve.map((p) => p.tenure));

  const coords = presence.curve.map((p) => {
    const x = maxDays > 0 ? (p.days / maxDays) * width : 0;
    const y = bottom - (p.tenure / maxTenure) * (bottom - top);
    return { x, y };
  });
  const points = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  // Close the polyline down to the baseline so the fill reads as accumulated area, not a lone line.
  const area = coords.length > 0 ? `${points} ${width},${bottom} 0,${bottom}` : "";

  const currentX = maxDays > 0 ? (presence.presentDays / maxDays) * width : 0;
  const currentY = bottom - (presence.tenureBonus / maxTenure) * (bottom - top);

  return (
    <svg
      data-testid="tenure-curve"
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      role="img"
      aria-label={`Tenure bonus ${presence.tenureBonus.toFixed(2)} of a maximum ${presence.tenureMaxBonus.toFixed(2)}`}
    >
      {fill && area ? <polygon points={area} fill={fill} stroke="none" /> : null}
      <line x1={0} y1={top} x2={width} y2={top} stroke={ceiling} strokeWidth={1} strokeDasharray="2 4" />
      <polyline points={points} fill="none" stroke={line} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      {/* soft halo behind the live point — where the curve is right now */}
      <circle cx={currentX} cy={currentY} r={5} fill={line} opacity={0.28} />
      <circle cx={currentX} cy={currentY} r={2.5} fill={line} />
    </svg>
  );
}
