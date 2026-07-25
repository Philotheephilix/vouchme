"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { encodeFunctionData, isAddress, type Hex } from "viem";
import { IDKitRequestWidget, selfieCheckLegacy, type IDKitResult } from "@worldcoin/idkit";
import { MiniKit } from "@worldcoin/minikit-js";
import { Header } from "@/components/Header";
import { StatLine } from "@/components/StatLine";
import { fmtHours, fmtScore, tierLabel, truncateMiddle } from "@/lib/format";
import type { CandidateVoucher, IdentityResult, SimulateVouchResult } from "@/lib/types";
import { useAuth } from "@/lib/session";
import { encodeVouchSignal, fetchRpContext, type RpContext } from "@/lib/worldid-client";
import {
  AVAL_REGISTRY_ABI,
  ClientConfigError,
  WORLDCHAIN_SEPOLIA_ID,
  explorerTxUrl,
  getAppId,
  getAvalRegistryAddress,
  getWorldIdAction,
} from "@/lib/worldchain";
import { decodeRevertReason, ensureWorldChainSepolia, submitFromInjected } from "@/lib/wallet";

const STEPS = ["Who?", "Preview", "Confirm", "Presence", "Transaction", "Result"] as const;

interface VouchAttestResponse {
  voucher: string;
  vouchee: string;
  voucherTier: number;
  deadline: string;
  nonce: string;
  attestation: Hex;
  environment: string;
}

function useClientConfig(): { appId: string; action: string; avalRegistry: `0x${string}` } | { error: string } {
  return useMemo(() => {
    try {
      return { appId: getAppId(), action: getWorldIdAction(), avalRegistry: getAvalRegistryAddress() };
    } catch (err) {
      return { error: err instanceof ClientConfigError ? err.message : "World ID is not configured." };
    }
  }, []);
}

export function VouchWizard() {
  const auth = useAuth();
  const config = useClientConfig();
  const [step, setStep] = useState(0);

  // ── step 0: who ──────────────────────────────────────────────────────────────────────────────
  const [candidates, setCandidates] = useState<CandidateVoucher[]>([]);
  const [query, setQuery] = useState("");
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  const [target, setTarget] = useState<IdentityResult | null>(null);

  // ── step 1: preview ──────────────────────────────────────────────────────────────────────────
  const [sim, setSim] = useState<SimulateVouchResult | null>(null);
  const [simError, setSimError] = useState<string | null>(null);
  const [simLoading, setSimLoading] = useState(false);

  // ── step 3: presence ─────────────────────────────────────────────────────────────────────────
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [presenceError, setPresenceError] = useState<string | null>(null);
  const [attestData, setAttestData] = useState<VouchAttestResponse | null>(null);
  const [attesting, setAttesting] = useState(false);

  // ── step 4: transaction ──────────────────────────────────────────────────────────────────────
  const [txHash, setTxHash] = useState<string | null>(null);
  const [txStatus, setTxStatus] = useState<"idle" | "pending" | "confirmed" | "reverted">("idle");
  const [txError, setTxError] = useState<string | null>(null);

  useEffect(() => {
    if (!auth.address) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/candidates/${encodeURIComponent(auth.address!)}`);
        const body = await res.json();
        if (!cancelled && res.ok && !body.error) setCandidates(body.data as CandidateVoucher[]);
      } catch {
        // best-effort — the free-text resolver below still works without a candidate list
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth.address]);

  const resolveTarget = useCallback(
    async (idOrAddress: string) => {
      setResolveError(null);
      setResolving(true);
      setTarget(null);
      try {
        const res = await fetch(`/api/identity/${encodeURIComponent(idOrAddress)}`);
        const body = await res.json();
        if (!res.ok || body.error) throw new Error(body?.error?.message ?? `No Aval account found for "${idOrAddress}".`);
        const identity = body.data as IdentityResult;
        if (auth.address && identity.address.toLowerCase() === auth.address.toLowerCase()) {
          throw new Error("You cannot vouch for yourself.");
        }
        setTarget(identity);
      } catch (err) {
        setResolveError(err instanceof Error ? err.message : String(err));
      } finally {
        setResolving(false);
      }
    },
    [auth.address],
  );

  // Deep-linked from a profile's "Vouch" CTA (/vouch?to=0x...) — auto-resolve that target once,
  // instead of making the user paste the address they just tapped.
  const searchParams = useSearchParams();
  const [autoResolved, setAutoResolved] = useState(false);
  useEffect(() => {
    const to = searchParams.get("to");
    if (to && !autoResolved && auth.address) {
      setAutoResolved(true);
      setQuery(to);
      void resolveTarget(to);
    }
  }, [searchParams, autoResolved, auth.address, resolveTarget]);

  const runSimulation = useCallback(async () => {
    if (!auth.address || !target) return;
    setSimLoading(true);
    setSimError(null);
    try {
      const res = await fetch("/api/simulate/vouch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voucher: auth.address, target: target.address }),
      });
      const body = await res.json();
      if (!res.ok || body.error) throw new Error(body?.error?.message ?? "Could not simulate this vouch.");
      setSim(body.data as SimulateVouchResult);
      setStep(1);
    } catch (err) {
      setSimError(err instanceof Error ? err.message : String(err));
    } finally {
      setSimLoading(false);
    }
  }, [auth.address, target]);

  const openPresence = useCallback(async () => {
    setPresenceError(null);
    try {
      const ctx = await fetchRpContext();
      setRpContext(ctx);
      setWidgetOpen(true);
    } catch (err) {
      setPresenceError(err instanceof Error ? err.message : "Could not prepare a World ID request.");
    }
  }, []);

  const handlePresenceSuccess = useCallback(
    async (result: IDKitResult) => {
      setWidgetOpen(false);
      if (!auth.address || !target) return;
      setAttesting(true);
      setPresenceError(null);
      try {
        const res = await fetch("/api/vouch/attest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ voucher: auth.address, vouchee: target.address, idkitResult: result }),
        });
        const body = await res.json();
        if (!res.ok || body.error) throw new Error(body?.error?.message ?? "Presence verification failed.");
        setAttestData(body.data as VouchAttestResponse);
        setStep(4);
      } catch (err) {
        setPresenceError(err instanceof Error ? err.message : String(err));
      } finally {
        setAttesting(false);
      }
    },
    [auth.address, target],
  );

  const sendVouchTx = useCallback(async () => {
    if (!auth.address || !target || !attestData || "error" in config) return;
    setTxError(null);
    setTxStatus("pending");
    try {
      const data = encodeFunctionData({
        abi: AVAL_REGISTRY_ABI,
        functionName: "vouch",
        args: [target.address, attestData.voucherTier, BigInt(attestData.deadline), BigInt(attestData.nonce), attestData.attestation],
      });
      if (auth.via === "minikit" && MiniKit.isInstalled()) {
        const result = await MiniKit.sendTransaction({ transactions: [{ to: config.avalRegistry, data }], chainId: WORLDCHAIN_SEPOLIA_ID });
        setTxHash(result.data.userOpHash);
        setTxStatus("confirmed");
      } else {
        await ensureWorldChainSepolia();
        const outcome = await submitFromInjected(auth.address, config.avalRegistry, data);
        setTxHash(outcome.hash);
        setTxStatus(outcome.status === "success" ? "confirmed" : "reverted");
        if (outcome.status !== "success") setTxError(outcome.revertReason ?? "Transaction reverted.");
      }
      setStep(5);
    } catch (err) {
      setTxStatus("reverted");
      setTxError(decodeRevertReason(err));
    }
  }, [auth.address, auth.via, attestData, config, target]);

  const first = step === 0;

  if (!auth.address) {
    return (
      <div className="pb-8">
        <Header eyebrow="VOUCH" />
        <section className="px-4 pt-10 text-center">
          <p className="text-sm leading-relaxed text-cream">Sign in to vouch for someone.</p>
          <button
            type="button"
            onClick={() => void auth.connect()}
            disabled={auth.connecting}
            className="mt-6 min-h-[44px] w-full border px-4 py-3 font-mono text-xs uppercase tracking-widest disabled:opacity-50"
            style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
          >
            {auth.connecting ? "Connecting…" : "Sign in"}
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="pb-8">
      <Header eyebrow="VOUCH" title={`step ${step + 1} of ${STEPS.length} — ${STEPS[step]}`} />

      <ol className="scroll-x flex gap-3 border-b border-rule px-4 py-3">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className="whitespace-nowrap font-mono text-2xs uppercase tracking-widest"
            style={{ color: i === step ? "var(--color-seal)" : i < step ? "var(--color-cream)" : "var(--color-graphite)" }}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      <section className="px-4 pt-6">
        {step === 0 ? (
          <div>
            <h2 className="mb-3 text-sm text-cream">Who are you vouching for?</h2>
            <p className="mb-4 text-2xs text-graphite">Paste a wallet address or an aval.eth handle.</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value.trim())}
                placeholder="0x… or handle.aval.eth"
                className="min-h-[44px] flex-1 border bg-transparent px-3 font-mono text-sm text-cream"
                style={{ borderColor: "var(--color-rule)" }}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
              />
              <button
                type="button"
                disabled={!query || resolving}
                onClick={() => void resolveTarget(isAddress(query) ? query : query.toLowerCase())}
                className="min-h-[44px] shrink-0 border px-3 font-mono text-2xs uppercase tracking-widest disabled:opacity-40"
                style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
              >
                {resolving ? "…" : "Resolve"}
              </button>
            </div>
            {resolveError ? (
              <p className="mt-2 text-2xs" style={{ color: "var(--color-protest)" }}>
                {resolveError}
              </p>
            ) : null}
            {target ? (
              <div className="mt-3 border px-3 py-2" style={{ borderColor: "var(--color-rule)" }}>
                <p className="truncate-mono font-mono text-sm text-cream">{target.ensName}</p>
                <p className="font-mono text-2xs text-graphite">
                  {target.kind} · {target.credentialStatus}
                </p>
              </div>
            ) : null}

            {candidates.length > 0 ? (
              <div className="mt-6">
                <h3 className="mb-2 font-mono text-2xs uppercase tracking-widest text-graphite">Or pick a prospective voucher target</h3>
                {candidates.map((c) => (
                  <button
                    key={c.ensName}
                    type="button"
                    onClick={() => void resolveTarget(c.address)}
                    className="flex w-full min-h-[44px] items-center justify-between border-b border-rule py-3 text-left"
                  >
                    <span className="truncate-mono max-w-[180px] text-sm" style={{ color: "var(--color-cream)" }}>
                      {truncateMiddle(c.ensName, 22)}
                    </span>
                    <span className="font-mono text-2xs text-graphite">
                      {tierLabel(c.tier)} · {fmtScore(c.score)}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-6 text-2xs text-graphite">No prospective candidates loaded — resolve someone directly above.</p>
            )}

            <button
              type="button"
              disabled={!target || simLoading}
              onClick={() => void runSimulation()}
              className="mt-8 min-h-[44px] w-full border px-4 font-mono text-xs uppercase tracking-widest disabled:opacity-30"
              style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
            >
              {simLoading ? "Simulating…" : "Preview"}
            </button>
            {simError ? (
              <p className="mt-2 text-2xs" style={{ color: "var(--color-protest)" }}>
                {simError}
              </p>
            ) : null}
          </div>
        ) : null}

        {step === 1 && sim ? (
          <div>
            <h2 className="mb-3 text-sm text-cream">aval_simulate_vouch</h2>
            <StatLine
              label={truncateMiddle(sim.target, 22)}
              value={`${fmtScore(sim.targetBefore.score)} → ${fmtScore(sim.targetAfter.score)}`}
              hint={`${tierLabel(sim.targetBefore.tier)} → ${tierLabel(sim.targetAfter.tier)}${sim.promotes ? " — promotes" : ""}`}
              valueColor="var(--color-seal)"
            />
            <StatLine
              label="You"
              value={`${sim.voucherSlotsBefore} slots → ${sim.voucherSlotsAfter}`}
              hint={`next vouch in ${fmtHours(sim.nextVouchAvailableInHours)}`}
            />
            {sim.secondaryEffects.map((s) => (
              <StatLine key={s.ensName} label={`also raises ${truncateMiddle(s.ensName, 18)}`} value={`${fmtScore(s.before)} → ${fmtScore(s.after)}`} />
            ))}
          </div>
        ) : null}

        {step === 2 ? (
          <div className="border px-4 py-3" style={{ borderColor: "var(--color-protest)" }}>
            <p className="text-sm leading-relaxed text-cream">
              <span className="font-mono" style={{ color: "var(--color-protest)" }}>
                ⚠
              </span>{" "}
              You are putting your name on this person. If they&apos;re confirmed fraudulent, you lose a slot for 30
              days.
            </p>
          </div>
        ) : null}

        {step === 3 ? (
          <div>
            <h2 className="mb-3 text-sm text-cream">World ID</h2>
            <p className="mb-4 text-2xs leading-relaxed text-graphite">
              <code className="font-mono">require_user_presence: true</code> — a vouch is the only operation that
              creates trust from nothing, so this is the one place the protocol spends friction. Reuses the same
              action as enrollment; the edge is bound through <code className="font-mono">signal</code>.
            </p>
            <button
              type="button"
              onClick={() => void openPresence()}
              disabled={attesting}
              className="min-h-[44px] w-full border px-4 py-3 font-mono text-xs uppercase tracking-widest disabled:opacity-50"
              style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
            >
              {attesting ? "Verifying…" : attestData ? "Verified — reopen" : "Open World ID"}
            </button>
            {presenceError ? (
              <p className="mt-3 text-2xs" style={{ color: "var(--color-protest)" }}>
                {presenceError}
              </p>
            ) : null}
            {target && !("error" in config) && rpContext ? (
              <IDKitRequestWidget
                open={widgetOpen}
                onOpenChange={setWidgetOpen}
                app_id={config.appId as `app_${string}`}
                action={config.action}
                rp_context={rpContext}
                allow_legacy_proofs={true}
                require_user_presence={true}
                preset={selfieCheckLegacy({ signal: encodeVouchSignal(auth.address, target.address) })}
                onSuccess={handlePresenceSuccess}
                onError={(code) => setPresenceError(`World ID error: ${code}`)}
              />
            ) : null}
          </div>
        ) : null}

        {step === 4 ? (
          <div>
            <h2 className="mb-3 text-sm text-cream">Transaction</h2>
            <p className="mb-4 font-mono text-2xs text-graphite">AvalRegistry.vouch(vouchee, tier, deadline, nonce, attestation)</p>
            <button
              type="button"
              onClick={() => void sendVouchTx()}
              disabled={txStatus === "pending" || !attestData}
              className="min-h-[44px] w-full border px-4 py-3 font-mono text-xs uppercase tracking-widest disabled:opacity-50"
              style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
            >
              {txStatus === "pending" ? "Sending…" : "Send vouch transaction"}
            </button>
            {txError ? (
              <p className="mt-3 text-2xs" style={{ color: "var(--color-protest)" }}>
                {txError}
              </p>
            ) : null}
          </div>
        ) : null}

        {step === 5 ? (
          <div>
            <h2 className="mb-3 text-sm text-cream">{txStatus === "reverted" ? "Reverted" : "Minted"}</h2>
            {target ? (
              <p className="truncate-mono text-base" style={{ color: txStatus === "reverted" ? "var(--color-protest)" : "var(--color-seal)" }}>
                {target.ensName}
              </p>
            ) : null}
            {txHash ? (
              <a
                href={explorerTxUrl(txHash)}
                target="_blank"
                rel="noreferrer"
                className="truncate-mono mt-2 block font-mono text-2xs underline"
                style={{ color: "var(--color-seal)" }}
              >
                {txHash}
              </a>
            ) : null}
            {txStatus === "reverted" ? (
              <p className="mt-3 text-2xs" style={{ color: "var(--color-protest)" }}>
                {txError}
              </p>
            ) : null}
          </div>
        ) : null}
      </section>

      {step > 0 ? (
        <div className="mt-8 flex gap-3 px-4">
          <button
            type="button"
            disabled={first}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            className="min-h-[44px] flex-1 border px-4 font-mono text-xs uppercase tracking-widest text-graphite disabled:opacity-30"
            style={{ borderColor: "var(--color-rule)" }}
          >
            Back
          </button>
          {step >= 1 && step <= 2 ? (
            <button
              type="button"
              onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}
              className="min-h-[44px] flex-1 border px-4 font-mono text-xs uppercase tracking-widest disabled:opacity-30"
              style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
            >
              Next
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
