"use client";

import { useCallback, useMemo, useState } from "react";
import { encodeFunctionData, type Hex } from "viem";
import { IDKitRequestWidget, selfieCheckLegacy, type IDKitResult } from "@worldcoin/idkit";
import { MiniKit } from "@worldcoin/minikit-js";
import { Header } from "@/components/Header";
import { ScoreDial } from "@/components/ScoreDial";
import { ENROLLMENT_BASE_SCORE } from "@/lib/mock";
import { useAuth } from "@/lib/session";
import { fetchRpContext, type RpContext } from "@/lib/worldid-client";
import {
  AVAL_REGISTRY_ABI,
  ClientConfigError,
  WORLDCHAIN_SEPOLIA_ID,
  ensExplorerTxUrl,
  explorerTxUrl,
  getAppId,
  getAvalRegistryAddress,
  getWorldIdAction,
} from "@/lib/worldchain";
import { decodeRevertReason, ensureWorldChainSepolia, sendFromInjected } from "@/lib/wallet";

const HANDLE_RE = /^[a-z0-9-]{3,20}$/;

interface EnrollAttestationResponse {
  address: `0x${string}`;
  handle: string;
  credential: Hex;
  nullifierHash: string;
  deadline: string;
  nonce: string;
  attestation: Hex;
  environment: string;
}

interface MintResponse {
  label: string;
  handle: string;
  address: `0x${string}`;
  registerTxHash: Hex | null;
  setAddrTxHash: Hex | null;
  resolvedAddress: `0x${string}` | null;
  alreadyComplete: boolean;
}

type Stage = "handle" | "verifying" | "attesting" | "submitting" | "minting" | "done";

/** Reads config eagerly so a missing NEXT_PUBLIC_APP_ID (etc.) is a clear, named banner on load —
 *  never a silent path into a widget that can't actually work. */
function useClientConfig(): { appId: string; action: string; avalRegistry: `0x${string}` } | { error: string } {
  return useMemo(() => {
    try {
      return { appId: getAppId(), action: getWorldIdAction(), avalRegistry: getAvalRegistryAddress() };
    } catch (err) {
      return { error: err instanceof ClientConfigError ? err.message : "World ID is not configured." };
    }
  }, []);
}

export default function EnrollPage() {
  const auth = useAuth();
  const config = useClientConfig();

  const [handle, setHandle] = useState("");
  const [handleError, setHandleError] = useState<string | null>(null);
  const [checkingHandle, setCheckingHandle] = useState(false);
  const [rpContext, setRpContext] = useState<RpContext | null>(null);
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [stage, setStage] = useState<Stage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [mint, setMint] = useState<MintResponse | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);

  const handleValid = HANDLE_RE.test(handle) && !handle.startsWith("-") && !handle.endsWith("-");

  const checkHandle = useCallback(async () => {
    if (!handleValid) {
      setHandleError("3-20 characters, lowercase a-z, 0-9 and hyphen only, not starting or ending with a hyphen.");
      return false;
    }
    setCheckingHandle(true);
    setHandleError(null);
    try {
      const res = await fetch(`/api/enroll/handle?h=${encodeURIComponent(handle)}`);
      const body = await res.json();
      if (!res.ok || body?.error) throw new Error(body?.error?.message ?? "Could not check handle availability.");
      if (!body.data.available) {
        setHandleError(body.data.reason ?? "That handle is not available.");
        return false;
      }
      return true;
    } catch (err) {
      setHandleError(err instanceof Error ? err.message : "Could not check handle availability.");
      return false;
    } finally {
      setCheckingHandle(false);
    }
  }, [handle, handleValid]);

  const startVerification = useCallback(async () => {
    setError(null);
    const available = await checkHandle();
    if (!available) return;
    if ("error" in config) return; // guarded by the banner below; unreachable in practice
    setStage("verifying");
    try {
      const ctx = await fetchRpContext();
      setRpContext(ctx);
      setWidgetOpen(true);
    } catch (err) {
      setStage(null);
      setError(err instanceof Error ? err.message : "Could not prepare a World ID verification request.");
    }
  }, [checkHandle, config]);

  // Order of operations matters: enroll on World Chain first (this is what makes `isEnrolled`
  // true and unlocks the rest of the app), then mint the ENSv2 subname. If the mint fails, the
  // user is still enrolled — `mintName` is safely re-callable on its own (see src/lib/ens.ts's
  // idempotent register/setAddr resume logic), and never re-runs `enroll()`.
  const mintName = useCallback(async (address: `0x${string}`) => {
    setStage("minting");
    setMintError(null);
    try {
      const res = await fetch("/api/ens/mint", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const body = await res.json();
      if (!res.ok || body?.error) throw new Error(body?.error?.message ?? "Minting your ENS name failed.");
      setMint(body.data as MintResponse);
    } catch (err) {
      setMintError(err instanceof Error ? err.message : "Minting your ENS name failed.");
    } finally {
      setStage("done");
    }
  }, []);

  const submitOnChain = useCallback(
    async (resp: EnrollAttestationResponse) => {
      setStage("submitting");
      try {
        const data = encodeFunctionData({
          abi: AVAL_REGISTRY_ABI,
          functionName: "enroll",
          args: [BigInt(resp.nullifierHash), resp.credential, resp.handle, BigInt(resp.deadline), BigInt(resp.nonce), resp.attestation],
        });
        if ("error" in config) throw new Error(config.error);

        if (auth.via === "minikit") {
          const result = await MiniKit.sendTransaction({
            chainId: WORLDCHAIN_SEPOLIA_ID,
            transactions: [{ to: config.avalRegistry, data }],
          });
          setTxHash(result.data.userOpHash);
        } else {
          await ensureWorldChainSepolia();
          const hash = await sendFromInjected(auth.address!, config.avalRegistry, data);
          setTxHash(hash);
        }
        // Enrolled on World Chain — now mint the name. A mint failure here must never look like
        // an enrollment failure: it's reported as its own, separately-retryable state below.
        await mintName(resp.address);
      } catch (err) {
        setStage(null);
        setError(decodeRevertReason(err));
      }
    },
    [auth, config, mintName],
  );

  const handleProofSuccess = useCallback(
    async (result: IDKitResult) => {
      setWidgetOpen(false);
      setStage("attesting");
      setError(null);
      try {
        const res = await fetch("/api/enroll", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address: auth.address, handle, idkitResult: result }),
        });
        const body = await res.json();
        if (!res.ok || body?.error) {
          throw new Error(body?.error?.message ?? "Enrollment attestation failed.");
        }
        await submitOnChain(body.data as EnrollAttestationResponse);
      } catch (err) {
        setStage(null);
        setError(err instanceof Error ? err.message : "Enrollment failed.");
      }
    },
    [auth.address, handle, submitOnChain],
  );

  if ("error" in config) {
    return (
      <div className="pb-8">
        <Header eyebrow="ENROLL" />
        <section className="px-4 pt-10">
          <div className="border px-4 py-3" style={{ borderColor: "var(--color-protest)" }}>
            <p className="font-mono text-2xs uppercase tracking-widest" style={{ color: "var(--color-protest)" }}>
              World ID not configured
            </p>
            <p className="mt-2 text-sm leading-relaxed text-cream">{config.error}</p>
          </div>
        </section>
      </div>
    );
  }

  if (stage === "minting" || stage === "done") {
    return (
      <div className="pb-8">
        <Header eyebrow="ENROLL" />
        <section className="px-4 pt-10 text-center">
          <h1 className="font-serif text-cream" style={{ fontSize: "var(--text-2xl)" }}>
            {handle}.aval.eth
          </h1>
          {/* The credential visibly earning the score, not the number just materialising — the
              guilloché stroke-draw plays on mount, exactly the moment it was built for. */}
          <div className="mt-4">
            <ScoreDial score={ENROLLMENT_BASE_SCORE} tier={0} countedVouchCount={0} size={140} />
          </div>
          <p className="mt-2 font-mono text-2xs uppercase tracking-widest text-graphite">
            base {ENROLLMENT_BASE_SCORE.toFixed(1)} · selfie check
          </p>
          {txHash ? (
            <a
              className="mt-2 block truncate-mono text-2xs underline"
              style={{ color: "var(--color-seal)" }}
              href={explorerTxUrl(txHash)}
              target="_blank"
              rel="noreferrer"
            >
              World Chain: {txHash}
            </a>
          ) : null}

          <div className="mt-6 border-t border-rule pt-4">
            {stage === "minting" ? (
              <p className="font-mono text-2xs uppercase tracking-widest text-graphite">
                Minting {handle}.aval.eth on Ethereum Sepolia…
              </p>
            ) : mint ? (
              <div>
                <p className="font-mono text-2xs text-graphite">
                  {mint.resolvedAddress ? "name minted and resolving" : "name minted, address record pending"}
                </p>
                {mint.registerTxHash ? (
                  <a
                    className="mt-1 block truncate-mono text-2xs underline"
                    style={{ color: "var(--color-seal)" }}
                    href={ensExplorerTxUrl(mint.registerTxHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    register: {mint.registerTxHash}
                  </a>
                ) : null}
                {mint.setAddrTxHash ? (
                  <a
                    className="mt-1 block truncate-mono text-2xs underline"
                    style={{ color: "var(--color-seal)" }}
                    href={ensExplorerTxUrl(mint.setAddrTxHash)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    setAddr: {mint.setAddrTxHash}
                  </a>
                ) : null}
              </div>
            ) : mintError ? (
              <div>
                <p className="text-2xs" style={{ color: "var(--color-protest)" }}>
                  {mintError}
                </p>
                <button
                  type="button"
                  onClick={() => void mintName(auth.address as `0x${string}`)}
                  className="mt-3 min-h-[44px] w-full border px-4 font-mono text-xs uppercase tracking-widest"
                  style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
                >
                  Retry minting your name
                </button>
              </div>
            ) : null}
          </div>

          <p className="mt-6 text-sm leading-relaxed text-cream">
            You&apos;re verified as a live human. That&apos;s the floor. It doesn&apos;t yet prove you only have one
            account — for that, two people who are already trusted need to vouch for you.
          </p>

          <button
            type="button"
            disabled={stage === "minting"}
            onClick={() => {
              // Hard navigation, not router.push: AppGate re-checks `isEnrolled` fresh on mount,
              // which is exactly what should now flip from "onboarding" to "the real app".
              window.location.href = "/";
            }}
            className="mt-8 min-h-[44px] w-full border px-4 py-3 font-mono text-xs uppercase tracking-widest disabled:opacity-40"
            style={{ borderColor: "var(--color-rule)" }}
          >
            Go to your dashboard
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="pb-8">
      <Header eyebrow="ENROLL" />

      <section className="px-4 pt-10 text-center">
        <h1 className="font-serif text-cream" style={{ fontSize: "var(--text-2xl)" }}>
          Aval
        </h1>
        <p className="mx-auto mt-4 max-w-xs text-sm leading-relaxed text-cream">
          Proof of human is a floor.
          <br />
          This is the ladder.
        </p>
        {/* Always visible, not gated behind a connected wallet — the flow starts with a wallet
            connect step, but "verify with World ID" is what this whole page is for, and a first
            (signed-out) view should say so without requiring a click first. */}
        <p className="mt-2 font-mono text-2xs uppercase tracking-widest text-graphite">
          Verify with World ID · Selfie Check · ~20 seconds
        </p>

        {!auth.address ? (
          <button
            type="button"
            onClick={() => void auth.connect()}
            disabled={auth.connecting}
            className="mt-8 min-h-[44px] w-full border px-4 py-3 font-mono text-xs uppercase tracking-widest disabled:opacity-50"
            style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
          >
            {auth.connecting ? "Connecting…" : "Connect wallet"}
          </button>
        ) : (
          <>
            <p className="mt-4 text-sm text-cream">Let&apos;s create your Aval account.</p>
            <p className="mt-1 truncate-mono font-mono text-2xs text-graphite">signed in as {auth.address}</p>

            <div className="mt-6 text-left">
              <label className="mb-1 block font-mono text-2xs uppercase tracking-widest text-graphite" htmlFor="handle">
                Choose a handle
              </label>
              <div className="flex items-stretch gap-2">
                <input
                  id="handle"
                  className="min-h-[44px] flex-1 border bg-transparent px-3 font-mono text-sm text-cream"
                  style={{ borderColor: "var(--color-rule)" }}
                  value={handle}
                  onChange={(e) => {
                    setHandle(e.target.value.trim().toLowerCase());
                    setHandleError(null);
                  }}
                  placeholder="carol"
                  disabled={stage !== null && stage !== "handle"}
                />
                <span className="flex items-center font-mono text-2xs text-graphite">.aval.eth</span>
              </div>
              {handleError ? (
                <p className="mt-1 text-2xs" style={{ color: "var(--color-protest)" }}>
                  {handleError}
                </p>
              ) : null}
            </div>

            <button
              type="button"
              onClick={() => void startVerification()}
              disabled={!handleValid || checkingHandle || (stage !== null && stage !== "handle")}
              className="mt-6 min-h-[44px] w-full border px-4 py-3 font-mono text-xs uppercase tracking-widest disabled:opacity-40"
              style={{ borderColor: "var(--color-seal)", color: "var(--color-seal)" }}
            >
              {checkingHandle
                ? "Checking handle…"
                : stage === "verifying"
                  ? "Opening World ID…"
                  : stage === "attesting"
                    ? "Verifying…"
                    : stage === "submitting"
                      ? "Submitting on-chain…"
                      : "Verify with World ID"}
            </button>
            <p className="mt-2 font-mono text-2xs text-graphite">Selfie Check · ~20 seconds</p>

            {error ? (
              <p className="mt-3 text-2xs" style={{ color: "var(--color-protest)" }}>
                {error}
              </p>
            ) : null}

            {rpContext ? (
              <IDKitRequestWidget
                open={widgetOpen}
                onOpenChange={setWidgetOpen}
                app_id={config.appId as `app_${string}`}
                action={config.action}
                rp_context={rpContext}
                allow_legacy_proofs={true}
                require_user_presence={false}
                preset={selfieCheckLegacy({ signal: auth.address })}
                onSuccess={handleProofSuccess}
                onError={(code) => {
                  setStage(null);
                  setError(`World ID verification error: ${code}`);
                }}
              />
            ) : null}
          </>
        )}
      </section>

      <div className="my-10 border-t border-rule" />

      <section className="px-4">
        <div className="mb-3 font-mono text-2xs uppercase tracking-widest text-graphite">
          After you verify — score {ENROLLMENT_BASE_SCORE.toFixed(1)}, tier 0
        </div>
        <p className="text-sm leading-relaxed text-cream">
          You&apos;re verified as a live human. That&apos;s the floor. It doesn&apos;t yet prove you only have
          one account — for that, two people who are already trusted need to vouch for you.
        </p>
      </section>
    </div>
  );
}
