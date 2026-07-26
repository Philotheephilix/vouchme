"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { encodeFunctionData, type Hex } from "viem";
import { IDKitRequestWidget, selfieCheckLegacy, type IDKitResult } from "@worldcoin/idkit";
import { MiniKit } from "@worldcoin/minikit-js";
import { Header } from "@/components/Header";
import { ScoreCard } from "@/components/ScoreCard";
import { FaceCapture } from "@/components/FaceCapture";
import { EnrollHandle, Minting, Success, VerifyWorldId } from "@/components/illustrations";
import { ANCHOR_VOUCH_CONTRIBUTION, ENROLLMENT_BASE_SCORE, TIER_1_THRESHOLD_SCORE } from "@/lib/mock";
import { activeMiniKit, inWorldAppNow, useAuth } from "@/lib/session";
import { fetchRpContext, type RpContext } from "@/lib/worldid-client";
import {
  VOUCHME_REGISTRY_ABI,
  ClientConfigError,
  WORLDCHAIN_ID,
  ensExplorerTxUrl,
  explorerTxUrl,
  getAppId,
  getVouchMeRegistryAddress,
  getWorldIdAction,
} from "@/lib/worldchain";
import { decodeRevertReason, ensureWorldChainSepolia, sendFromInjected } from "@/lib/wallet";

const HANDLE_RE = /^[a-z0-9-]{3,20}$/;

/**
 * What enrollment actually leaves you needing, computed from the engine's own constants.
 *
 * The count must never be hardcoded in copy: it depends on who the vouchers are. Two *anchors*
 * clear Tier 1 (20 + 20 + 20 = 60 >= 55), three ordinary Tier 1 members clear it, two ordinary
 * members do not.
 */
const ANCHORS_TO_TIER_1 = Math.ceil((TIER_1_THRESHOLD_SCORE - ENROLLMENT_BASE_SCORE) / ANCHOR_VOUCH_CONTRIBUTION);
const AFTER_ENROLL_COPY =
  `You're verified as a live human. That's the floor — score ${ENROLLMENT_BASE_SCORE.toFixed(1)}, Tier 0. It doesn't ` +
  `yet prove you only have one account. Tier 1 starts at ${TIER_1_THRESHOLD_SCORE.toFixed(1)}, and each vouch is ` +
  `worth a quarter of the voucher's own score, capped at ${ANCHOR_VOUCH_CONTRIBUTION.toFixed(1)}: ` +
  `${ANCHORS_TO_TIER_1} vouches from Orb-verified people get you there, and more than that if they aren't.`;

/**
 * Poll until `/api/identity/{address}` stops returning 404 — i.e. the `Enrolled` event is actually
 * readable from chain.
 *
 * Needed because World App returns a UserOperation hash the moment the bundler accepts the call,
 * not when it is mined. Anything that reads chain state straight afterwards is racing the block.
 *
 * Resolves rather than throws on timeout: enrollment itself has already succeeded by this point,
 * so a slow block must not be reported to the user as a failed enrollment. The mint that follows
 * is independently retryable and reports its own outcome.
 */
async function waitForEnrollmentOnChain(address: `0x${string}`, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(`/api/identity/${encodeURIComponent(address)}`, { cache: "no-store" });
      if (res.ok) return;
    } catch {
      // Network blip — keep waiting; the deadline below is the only exit.
    }
    if (Date.now() >= deadline) return;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

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
  registryDeployTxHash: Hex | null;
  /** docs/04-ens.md §7: "a member = a PermissionedRegistry they own." This is theirs — the
   *  contract that will hold every vouch they issue as a subname. */
  subregistry: `0x${string}` | null;
  resolvedAddress: `0x${string}` | null;
  alreadyComplete: boolean;
}

type Stage = "handle" | "verifying" | "attesting" | "submitting" | "minting" | "done";

/** Reads config eagerly so a missing NEXT_PUBLIC_APP_ID (etc.) is a clear, named banner on load —
 *  never a silent path into a widget that can't actually work. */
function useClientConfig(): { appId: string; action: string; vouchMeRegistry: `0x${string}` } | { error: string } {
  return useMemo(() => {
    try {
      return { appId: getAppId(), action: getWorldIdAction(), vouchMeRegistry: getVouchMeRegistryAddress() };
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
  // World App returns a UserOperation hash, which is NOT a transaction hash: `worldscan.org/tx/…`
  // does not resolve it, so it must not be rendered as an explorer link.
  const [txIsUserOp, setTxIsUserOp] = useState(false);
  const [mint, setMint] = useState<MintResponse | null>(null);
  const [mintError, setMintError] = useState<string | null>(null);
  // The scanned face — captured here, stored device-local, and the sole source for the home hero's
  // particle bust. There is no default face, so this capture is what makes the dashboard's face real.
  const [faceCaptured, setFaceCaptured] = useState(false);
  // The step's only forward action is the page-level CTA at the bottom of this screen, which sits
  // below the fold on a phone. Capturing a face changes nothing the user can see without
  // scrolling, so the capture brings the CTA to them.
  const ctaRef = useRef<HTMLButtonElement | null>(null);

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
          abi: VOUCHME_REGISTRY_ABI,
          functionName: "enroll",
          args: [BigInt(resp.nullifierHash), resp.credential, resp.handle, BigInt(resp.deadline), BigInt(resp.nonce), resp.attestation],
        });
        if ("error" in config) throw new Error(config.error);

        // Host-based, and issued through the live MiniKit object — `auth.via` is only as good as
        // the detection that set it, and the imported class may not be the installed one
        // (src/lib/session.tsx `activeMiniKit`).
        if (inWorldAppNow()) {
          const result = await activeMiniKit().sendTransaction({
            chainId: WORLDCHAIN_ID,
            transactions: [{ to: config.vouchMeRegistry, data }],
          });
          setTxHash(result.data.userOpHash);
          setTxIsUserOp(true);
        } else {
          await ensureWorldChainSepolia();
          const hash = await sendFromInjected(auth.address!, config.vouchMeRegistry, data);
          setTxHash(hash);
          setTxIsUserOp(false);
        }
        // Enrolled on World Chain — now mint the name. A mint failure here must never look like
        // an enrollment failure: it's reported as its own, separately-retryable state below.
        //
        // Wait for the enrollment to be VISIBLE ON CHAIN first. MiniKit returns a `userOpHash`,
        // not a mined transaction hash — World App bundles the call as a UserOperation and returns
        // as soon as it is accepted, well before it lands in a block, so the mint's server-side
        // "is this wallet enrolled?" check would otherwise run too early. The injected path is
        // already safe because `sendFromInjected` awaits a receipt.
        await waitForEnrollmentOnChain(resp.address);
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
        <Header eyebrow="ENROLL" title="Enroll" />
        <section className="px-4 pt-6">
          <div className="rounded-[10px] border border-protest/40 p-4" style={{ backgroundColor: "var(--color-protest-subtle)" }}>
            <p className="eyebrow text-protest">
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
        <Header eyebrow="ENROLL" title="You're in" subtitle={`${handle}.vouchme.eth is yours`} />
        <section className="px-4 pt-2 text-center">
          {/* Minting still running vs. minted-and-done — the spot illustration carries the moment. */}
          <div className="mb-4 flex justify-center anim-rise-bounce" style={{ color: "var(--color-cream)" }}>
            {stage === "minting" ? <Minting size={196} /> : <Success size={196} />}
          </div>
          {/* The first thing you own here, worn like a card: base score, Tier 0, your fresh name. */}
          <div className="text-left">
            <ScoreCard
              name={`${handle}.vouchme.eth`}
              address={(auth.address ?? "0x0000") as string}
              score={ENROLLMENT_BASE_SCORE}
              tier={0}
              depth={null}
            />
          </div>
          <p className="eyebrow mt-3">
            base {ENROLLMENT_BASE_SCORE.toFixed(1)} · selfie check
          </p>
          {txHash && !txIsUserOp ? (
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
          {txHash && txIsUserOp ? (
            <p className="mt-2 truncate-mono font-mono text-2xs text-graphite">
              World Chain user operation: {txHash} — not a transaction hash, so there is no explorer page for it.
            </p>
          ) : null}

          <div className="mt-6 border-t border-rule pt-4">
            {stage === "minting" ? (
              <p className="eyebrow">
                Minting {handle}.vouchme.eth on Ethereum Sepolia…
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
                {/* `register()` and `deployMemberRegistry()` both pass DEPLOYER_ADDRESS as owner,
                    so the name and the registry belong to VouchMe's operator key, not to the person
                    who just enrolled — hence the custody note below. */}
                {mint.subregistry ? (
                  <>
                    <p className="mt-2 truncate-mono font-mono text-2xs text-graphite">
                      registry for your vouches: {mint.subregistry}
                    </p>
                    <p className="mt-1 text-2xs leading-relaxed text-graphite">
                      VouchMe holds this name and this registry on your behalf — they are registered to the operator
                      key, not to your wallet. The name resolves to your address.
                    </p>
                  </>
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
                  className="btn btn-primary btn-block mt-3"
                >
                  Retry minting your name
                </button>
              </div>
            ) : null}
          </div>

          {/* Scan the face that becomes your dashboard. It is the only source for that particle
              face — skip it and the hero shows an empty ring, never a stand-in. */}
          {auth.address ? (
            <div className="mt-6 border-t border-rule pt-5 text-left">
              <FaceCapture
                address={auth.address}
                onCaptured={() => {
                  setFaceCaptured(true);
                  ctaRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
              />
            </div>
          ) : null}

          <p className="mt-6 text-sm leading-relaxed text-cream">{AFTER_ENROLL_COPY}</p>

          <button
            ref={ctaRef}
            type="button"
            disabled={stage === "minting"}
            onClick={() => {
              // Hard navigation, not router.push: AppGate re-checks `isEnrolled` fresh on mount,
              // which is exactly what should now flip from "onboarding" to "the real app".
              window.location.href = "/";
            }}
            className="btn btn-secondary btn-block mt-8 disabled:opacity-40"
          >
            {faceCaptured ? "Go to your dashboard" : "Skip for now — go to dashboard"}
          </button>
        </section>
      </div>
    );
  }

  return (
    <div className="pb-8">
      <Header eyebrow="ENROLL" title="Create your account" subtitle="Proof of human is a floor — this is the ladder." />

      <section className="px-4 pt-4 text-center">
        {/* Spot illustration for the moment: choosing a handle, or the live World ID verification. */}
        <div className="mb-2 flex justify-center anim-rise-bounce" style={{ color: "var(--color-cream)" }}>
          {stage === "verifying" || stage === "attesting" || stage === "submitting" ? (
            <VerifyWorldId size={204} />
          ) : (
            <EnrollHandle size={204} />
          )}
        </div>
        {/* Always visible, not gated behind a connected wallet: the signed-out first view should
            still say what this page is for. */}
        <p className="eyebrow mt-2">
          Verify with World ID · Selfie Check · ~20 seconds
        </p>

        {!auth.address ? (
          <button
            type="button"
            onClick={() => void auth.connect()}
            disabled={auth.connecting}
            className="btn btn-primary btn-block btn-lg mt-8 disabled:opacity-50"
          >
            {auth.connecting ? "Connecting…" : "Connect wallet"}
          </button>
        ) : (
          <>
            <p className="mt-4 text-sm text-cream">Let&apos;s create your VouchMe account.</p>
            <p className="mt-1 truncate-mono font-mono text-2xs text-graphite">signed in as {auth.address}</p>

            <div className="mt-6 text-left">
              <label className="eyebrow mb-1 block" htmlFor="handle">
                Choose a handle
              </label>
              <div className="flex items-stretch gap-2">
                <input
                  id="handle"
                  className="field flex-1"
                  value={handle}
                  onChange={(e) => {
                    setHandle(e.target.value.trim().toLowerCase());
                    setHandleError(null);
                  }}
                  placeholder="yourname"
                  disabled={stage !== null && stage !== "handle"}
                />
                <span className="flex items-center font-mono text-2xs text-graphite">.vouchme.eth</span>
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
              className="btn btn-primary btn-block btn-lg mt-6 disabled:opacity-40"
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
    </div>
  );
}
