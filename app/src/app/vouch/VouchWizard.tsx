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
import { activeMiniKit, inWorldAppNow, useAuth } from "@/lib/session";
import { encodeVouchSignal, fetchRpContext, type RpContext } from "@/lib/worldid-client";
import {
  VOUCHME_REGISTRY_ABI,
  ClientConfigError,
  WORLDCHAIN_ID,
  explorerTxUrl,
  getAppId,
  getVouchMeRegistryAddress,
  getWorldIdAction,
} from "@/lib/worldchain";
import { decodeRevertReason, ensureWorldChainSepolia, submitFromInjected } from "@/lib/wallet";

// Step 3 is "Verify", not "Presence": `selfieCheckLegacy()` returns World ID 3.0 proofs, which
// carry no presence field, so no liveness is established at this step.
const STEPS = ["Who?", "Preview", "Confirm", "Verify", "Transaction", "Result"] as const;

interface VouchAttestResponse {
  voucher: string;
  vouchee: string;
  voucherTier: number;
  deadline: string;
  nonce: string;
  attestation: Hex;
  environment: string;
}

/** docs/04-ens.md §7.1 — the vouch as a name: `register(vouchee)` inside the VOUCHER's own
 *  registry, i.e. a real `carol.alice.vouchme.eth`. Minted on Ethereum Sepolia by `/api/vouch/ens`
 *  after the World Chain vouch lands. */
interface VouchEnsResponse {
  name: string;
  voucherRegistry: string;
  voucheeRegistry: string;
  registerTxHash: string | null;
  setAddrTxHash: string | null;
  resolvedAddress: string | null;
  alreadyComplete: boolean;
}

type EnsMintState =
  | { kind: "idle" }
  | { kind: "minting" }
  | { kind: "minted"; data: VouchEnsResponse }
  | { kind: "unavailable"; message: string }
  | { kind: "failed"; message: string };

const sepoliaTxUrl = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

function useClientConfig(): { appId: string; action: string; vouchMeRegistry: `0x${string}` } | { error: string } {
  return useMemo(() => {
    try {
      return { appId: getAppId(), action: getWorldIdAction(), vouchMeRegistry: getVouchMeRegistryAddress() };
    } catch (err) {
      return { error: err instanceof ClientConfigError ? err.message : "World ID is not configured." };
    }
  }, []);
}


/**
 * Poll `/api/score/{vouchee}` until the voucher actually appears in their breakdown — i.e. the
 * `Vouched` event is on chain and the engine has counted it.
 *
 * World App's `sendTransaction` resolves with a bundler UserOperation hash, which proves only that
 * the call was accepted for inclusion — never that it landed.
 *
 * Returns false on timeout rather than throwing: the vouch may still land later, so the honest
 * report is "submitted, not yet confirmed", never "failed".
 */
async function readVouchIssuedAt(vouchee: string, voucher: string): Promise<string | null> {
  const res = await fetch(`/api/score/${encodeURIComponent(vouchee)}`, { cache: "no-store" });
  if (!res.ok) return null;
  const body: unknown = await res.json();
  const rows =
    (body as { data?: { breakdown?: Array<{ voucher?: { address?: string }; issuedAt?: string }> } }).data?.breakdown ??
    [];
  const row = rows.find((r) => r.voucher?.address?.toLowerCase() === voucher.toLowerCase());
  return row?.issuedAt ?? null;
}

/**
 * Wait until a vouch from `voucher` to `vouchee` that is STRICTLY NEWER than `priorIssuedAt` is
 * readable from chain.
 *
 * The `priorIssuedAt` argument is what makes this a test for *new*. "Does a vouch from this voucher
 * appear in the vouchee's breakdown?" is already true wherever an edge exists, and `vouch()` reverts
 * with `VouchExists()` when the edge is present and `RateLimited()` inside 24h of the voucher's last
 * vouch — so that predicate would report success for a transaction that cannot land. Comparing
 * against the edge's `issuedAt` as observed BEFORE sending answers the question actually being
 * asked. `null` means no edge existed, so any row is new.
 *
 * Returns false on timeout rather than throwing: the transaction may still land, so the honest
 * report is "submitted, not yet confirmed" — never "failed", and never "confirmed".
 */
async function waitForNewVouchOnChain(
  vouchee: `0x${string}`,
  voucher: `0x${string}`,
  priorIssuedAt: string | null,
  timeoutMs = 120_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const issuedAt = await readVouchIssuedAt(vouchee, voucher);
      if (issuedAt !== null && issuedAt !== priorIssuedAt) return true;
    } catch {
      // Network blip — the deadline below is the only exit.
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
}

export function VouchWizard() {
  const auth = useAuth();
  const config = useClientConfig();
  const [step, setStep] = useState(0);

  // ── step 0: who ──────────────────────────────────────────────────────────────────────────────
  const [candidates, setCandidates] = useState<CandidateVoucher[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(true);
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
  // World App returns a UserOperation hash; `worldscan.org/tx/<userOpHash>` does not resolve, so
  // it must not be rendered as an explorer link.
  const [txIsUserOp, setTxIsUserOp] = useState(false);
  const [txError, setTxError] = useState<string | null>(null);

  // ── step 5: the vouch as an ENS name ─────────────────────────────────────────────────────────
  const [ensMint, setEnsMint] = useState<EnsMintState>({ kind: "idle" });

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
      } finally {
        if (!cancelled) setCandidatesLoading(false);
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
        // The field accepts a wallet address or a vouchme.eth handle, so a bare handle must resolve
        // too: try it as typed, then with the `.vouchme.eth` suffix. Same fallback as SearchBox.
        const q = idOrAddress.trim();
        const attempts = isAddress(q) || q.includes(".") ? [q] : [q, `${q}.vouchme.eth`];
        let identity: IdentityResult | null = null;
        let lastError = `No VouchMe account found for "${q}".`;
        for (const attempt of attempts) {
          const res = await fetch(`/api/identity/${encodeURIComponent(attempt)}`);
          const body = await res.json();
          if (res.ok && !body.error) {
            identity = body.data as IdentityResult;
            break;
          }
          lastError = body?.error?.message ?? lastError;
        }
        if (!identity) throw new Error(lastError);
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

  /** Mints `<vouchee>.<voucher>.vouchme.eth` for real, and reports honestly when it can't. */
  const mintVouchName = useCallback(async () => {
    if (!auth.address || !target) return;
    setEnsMint({ kind: "minting" });
    try {
      const res = await fetch("/api/vouch/ens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voucher: auth.address, vouchee: target.address }),
      });
      const body = await res.json();
      if (res.status === 409 && body?.error?.code === "vouch_name_unavailable") {
        setEnsMint({ kind: "unavailable", message: body.error.message as string });
        return;
      }
      if (!res.ok || body.error) throw new Error(body?.error?.message ?? "Could not mint the vouch name.");
      setEnsMint({ kind: "minted", data: body.data as VouchEnsResponse });
    } catch (err) {
      setEnsMint({ kind: "failed", message: err instanceof Error ? err.message : String(err) });
    }
  }, [auth.address, target]);

  const sendVouchTx = useCallback(async () => {
    if (!auth.address || !target || !attestData || "error" in config) return;
    setTxError(null);
    setTxStatus("pending");
    try {
      const data = encodeFunctionData({
        abi: VOUCHME_REGISTRY_ABI,
        functionName: "vouch",
        args: [target.address, attestData.voucherTier, BigInt(attestData.deadline), BigInt(attestData.nonce), attestData.attestation],
      });
      // Snapshot the edge's current issuedAt BEFORE broadcasting. Without this the confirmation
      // check cannot tell a vouch that just landed from one that was already there — see
      // `waitForNewVouchOnChain`.
      const priorIssuedAt = await readVouchIssuedAt(target.address, auth.address).catch(() => null);

      let landed = false;
      // Gate on the host, not on `MiniKit.isInstalled()` — that reads a per-module-copy flag that
      // can be false in a working World App session (src/lib/session.tsx `activeMiniKit`).
      if (inWorldAppNow()) {
        const result = await activeMiniKit().sendTransaction({ transactions: [{ to: config.vouchMeRegistry, data }], chainId: WORLDCHAIN_ID });
        // A UserOperation hash, NOT a transaction hash. World App returns it the moment its bundler
        // accepts the call — before it is mined, and before it is known to have succeeded — hence
        // the on-chain poll below. The injected branch awaits a receipt instead.
        setTxHash(result.data.userOpHash);
        setTxIsUserOp(true);
        setTxStatus("pending");
        landed = await waitForNewVouchOnChain(target.address, auth.address, priorIssuedAt);
        setTxStatus(landed ? "confirmed" : "pending");
      } else {
        await ensureWorldChainSepolia();
        const outcome = await submitFromInjected(auth.address, config.vouchMeRegistry, data);
        setTxHash(outcome.hash);
        setTxStatus(outcome.status === "success" ? "confirmed" : "reverted");
        if (outcome.status !== "success") setTxError(outcome.revertReason ?? "Transaction reverted.");
        landed = outcome.status === "success";
      }
      setStep(5);
      // Only once the trust edge actually exists on World Chain is the name minted on Sepolia.
      if (landed) void mintVouchName();
    } catch (err) {
      setTxStatus("reverted");
      setTxError(decodeRevertReason(err));
    }
  }, [auth.address, auth.via, attestData, config, target, mintVouchName]);

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
            <p className="mb-4 text-2xs text-graphite">Paste a wallet address or a vouchme.eth handle.</p>
            <div className="flex gap-2">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value.trim())}
                placeholder="0x… or handle.vouchme.eth"
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
                {/* This list is `/api/candidates/{me}`, which returns people who could vouch FOR
                    you — `candidatesFor` filters to tier >= 1 and "not already vouching you".
                    They are not vouch targets, so a row opens their profile. */}
                <h3 className="mb-2 font-mono text-2xs uppercase tracking-widest text-graphite">People who could vouch for you</h3>
                <p className="mb-2 text-2xs leading-relaxed text-graphite">
                  Not people to vouch for — these are Tier 1+ accounts whose vouch would raise your score. Open one to
                  ask.
                </p>
                {candidates.map((c) => (
                  <button
                    key={c.ensName}
                    type="button"
                    onClick={() => { window.location.href = `/profile/${c.address}`; }}
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
            ) : candidatesLoading ? (
              <p className="mt-6 text-2xs text-graphite">Looking for accounts that could vouch for you…</p>
            ) : (
              <p className="mt-6 text-2xs text-graphite">
                Nobody on this deployment can vouch for you yet — vouching needs Tier 1, and no other account has
                reached it.
              </p>
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
            <h2 className="mb-3 text-sm text-cream">vouchme_simulate_vouch</h2>
            <StatLine
              label={truncateMiddle(sim.target, 22)}
              value={`${fmtScore(sim.targetBefore.score)} → ${fmtScore(sim.targetAfter.score)}`}
              hint={`${tierLabel(sim.targetBefore.tier)} → ${tierLabel(sim.targetAfter.tier)}${sim.promotes ? " — promotes" : ""}`}
              valueColor="var(--color-seal)"
            />
            <StatLine
              label="You"
              value={
                sim.blockers.length > 0
                  ? `${sim.voucherSlotsBefore} slots — unchanged`
                  : `${sim.voucherSlotsBefore} slots → ${sim.voucherSlotsAfter}`
              }
              hint={
                sim.nextVouchAvailableInHours > 0
                  ? `next vouch in ${fmtHours(sim.nextVouchAvailableInHours)}`
                  : "you can vouch now"
              }
            />
            {/* `VouchMeRegistry.vouch()` reverts on `VouchExists()` and `RateLimited()` — refuse here
                rather than after walking the user through a ~20s Selfie Check. */}
            {sim.blockers.length > 0 ? (
              <div className="mt-4 border px-4 py-3" style={{ borderColor: "var(--color-protest)" }}>
                <p className="font-mono text-2xs uppercase tracking-widest" style={{ color: "var(--color-protest)" }}>
                  This vouch would fail on chain
                </p>
                {sim.blockers.map((b) => (
                  <p key={b} className="mt-1 text-sm leading-relaxed text-cream">
                    {b}
                  </p>
                ))}
                <p className="mt-2 text-2xs leading-relaxed text-graphite">
                  Nothing has been sent. Pick someone else, or come back when the window has passed.
                </p>
              </div>
            ) : null}
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
              You are putting your name on{" "}
              <span className="font-mono text-cream">{target?.ensName ?? "this account"}</span>. If they&apos;re
              confirmed fraudulent, you lose a slot for 30 days.
            </p>
          </div>
        ) : null}

        {step === 3 ? (
          <div>
            <h2 className="mb-3 text-sm text-cream">World ID</h2>
            <p className="mb-4 text-2xs leading-relaxed text-graphite">
              A vouch is the only operation that creates trust from nothing, so this is the one place the protocol
              spends friction. Reuses the same action as enrollment, so the returned nullifier must equal the one you
              enrolled with — checked server-side, not here — and the edge is bound through{" "}
              <code className="font-mono">signal</code>.
            </p>
            <p className="mb-4 text-2xs leading-relaxed" style={{ color: "var(--color-graphite)" }}>
              Liveness (<code className="font-mono">require_user_presence</code>) is not enforced on this step:
              Selfie Check returns World ID 3.0 proofs, which carry no presence field. See errata E-19.
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
                // MUST stay false while the preset is `selfieCheckLegacy`. idkit-core gates on a
                // World ID 4.0-only field:
                //
                //     const userPresenceCompleted = getUserPresenceCompleted(responsePayload);
                //     if (config.require_user_presence === true && !userPresenceCompleted)
                //       this.complete({ success: false, error: "user_presence_failed" });
                //
                //     getUserPresenceCompleted = p => p?.user_presence_completed === true
                //                                  || p?.proof_response?.user_presence_completed === true
                //
                // `selfieCheckLegacy()` returns 3.0 proofs, whose payload has no such field — so with
                // `true` the user completes a real face scan and IDKit then rejects it as
                // `user_presence_failed`. Unsatisfiable by construction, not a flaky check.
                //
                // What actually secures the vouch is enforced on the SERVER (api/vouch/attest): the
                // returned nullifier must equal the account's enrolled nullifier (same action ⇒
                // same nullifier), and `signal` binds the proof to this exact voucher→vouchee edge.
                // Liveness is the only property lost.
                require_user_presence={false}
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
            <p className="mb-4 font-mono text-2xs text-graphite">VouchMeRegistry.vouch(vouchee, tier, deadline, nonce, attestation)</p>
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
            <h2 className="mb-3 text-sm text-cream">{txStatus === "reverted" ? "Reverted" : "Vouched"}</h2>
            {target ? (
              <p className="truncate-mono text-base" style={{ color: txStatus === "reverted" ? "var(--color-protest)" : "var(--color-seal)" }}>
                {target.ensName}
              </p>
            ) : null}
            {/* A UserOperation hash is not a transaction hash — `worldscan.org/tx/<userOpHash>`
                does not resolve, so only link when it really is a tx hash. */}
            {txHash ? (
              txIsUserOp ? (
                <div className="mt-2">
                  <div className="font-mono text-2xs uppercase tracking-widest text-graphite">
                    World App user operation
                  </div>
                  <div className="truncate-mono font-mono text-2xs text-cream">{txHash}</div>
                  <div className="mt-1 text-2xs text-graphite">
                    Not a transaction hash — World App bundles the call, so this id isn&apos;t on the block explorer.
                    The vouch below is confirmed by reading the chain, not by this id.
                  </div>
                </div>
              ) : (
                <a
                  href={explorerTxUrl(txHash)}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate-mono mt-2 block font-mono text-2xs underline"
                  style={{ color: "var(--color-seal)" }}
                >
                  {txHash}
                </a>
              )
            ) : null}
            {txStatus === "reverted" ? (
              <p className="mt-3 text-2xs" style={{ color: "var(--color-protest)" }}>
                {txError}
              </p>
            ) : null}

            {txStatus !== "reverted" ? (
              <div className="mt-6 border-t border-rule pt-4">
                <h3 className="mb-2 font-mono text-2xs uppercase tracking-widest text-graphite">The vouch, as a name</h3>
                {ensMint.kind === "idle" || ensMint.kind === "minting" ? (
                  <p className="text-2xs text-graphite">Minting the subname on Ethereum Sepolia…</p>
                ) : null}
                {ensMint.kind === "minted" ? (
                  <>
                    <p className="truncate-mono text-base" style={{ color: "var(--color-seal)" }}>
                      {ensMint.data.name}
                    </p>
                    <p className="mt-1 font-mono text-2xs text-graphite">
                      resolves to {truncateMiddle(ensMint.data.resolvedAddress ?? "—", 22)}
                    </p>
                    {ensMint.data.registerTxHash ? (
                      <a
                        href={sepoliaTxUrl(ensMint.data.registerTxHash)}
                        target="_blank"
                        rel="noreferrer"
                        className="truncate-mono mt-2 block font-mono text-2xs underline"
                        style={{ color: "var(--color-seal)" }}
                      >
                        {ensMint.data.registerTxHash}
                      </a>
                    ) : (
                      <p className="mt-2 text-2xs text-graphite">Already minted by an earlier attempt — nothing rewritten.</p>
                    )}
                  </>
                ) : null}
                {ensMint.kind === "unavailable" ? (
                  <p className="text-2xs leading-relaxed" style={{ color: "var(--color-protest)" }}>
                    Not minted. {ensMint.message}
                  </p>
                ) : null}
                {ensMint.kind === "failed" ? (
                  <>
                    <p className="text-2xs leading-relaxed" style={{ color: "var(--color-protest)" }}>
                      Not minted. {ensMint.message}
                    </p>
                    <button
                      type="button"
                      onClick={() => void mintVouchName()}
                      className="mt-3 min-h-[44px] w-full border px-4 font-mono text-2xs uppercase tracking-widest"
                      style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
                    >
                      Retry the name
                    </button>
                  </>
                ) : null}
              </div>
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
              // Hard stop, not a warning: past this point the next thing the user does is a ~20s
              // face scan, and the transaction at the end of it cannot succeed.
              disabled={(sim?.blockers.length ?? 0) > 0}
              title={sim?.blockers[0]}
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
