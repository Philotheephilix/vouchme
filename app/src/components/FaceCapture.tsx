"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { saveFace } from "@/lib/faceStore";

/**
 * FaceCapture — the onboarding step that turns the device camera into the stored face that the
 * home hero (`FaceMesh`) is built from. It is the ONLY source of that face; there is no default.
 *
 * Flow: request the front camera → mirror a live preview inside an oval guide → on capture, draw
 * the current video frame to a square canvas, downscale to `OUT` px, and hand back a JPEG data URL
 * (also persisted via `saveFace(address, …)`). Retake re-opens the stream. Tracks are always
 * stopped on unmount and after a successful capture so the camera light doesn't linger.
 *
 * No face-landmark ML: the user aligns their face in the oval, and `FaceMesh` samples the framed
 * region into particles. Good enough to read as "your face", and dependency-free.
 */

const OUT = 256; // stored square size — enough detail to sample ~40k particles from

/** Resolve once the element actually has frame dimensions, i.e. once there is something to draw.
 *
 *  `play()` resolving does NOT mean that: `videoWidth` stays 0 until the stream's metadata lands,
 *  and in an in-app WebView (World App included) that can be hundreds of milliseconds later. A
 *  capture attempted before then finds `videoWidth === 0` and can draw nothing, so the phase has
 *  to wait for this rather than for `play()`.
 *
 *  Both events AND a poll: some WebViews fire neither `loadedmetadata` nor `canplay` for a
 *  MediaStream source, so the events are an optimisation and the poll is the guarantee. */
function waitForFrame(v: HTMLVideoElement, timeoutMs = 8000): Promise<boolean> {
  if (v.videoWidth > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      v.removeEventListener("loadedmetadata", check);
      v.removeEventListener("canplay", check);
      resolve(ok);
    };
    const check = () => {
      if (v.videoWidth > 0) finish(true);
    };
    v.addEventListener("loadedmetadata", check);
    v.addEventListener("canplay", check);
    const poll = setInterval(check, 100);
    const timer = setTimeout(() => finish(v.videoWidth > 0), timeoutMs);
  });
}

export interface FaceCaptureProps {
  address: string;
  /** called with the stored data URL once a face is captured (and saved) */
  onCaptured?: (dataUrl: string) => void;
  /** show the captured still if one already exists */
  initialDataUrl?: string | null;
}

type Phase = "idle" | "starting" | "live" | "captured" | "error";

export function FaceCapture({ address, onCaptured, initialDataUrl = null }: FaceCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [phase, setPhase] = useState<Phase>(initialDataUrl ? "captured" : "idle");
  const [error, setError] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(initialDataUrl);

  const stopStream = useCallback(() => {
    const s = streamRef.current;
    if (s) {
      for (const t of s.getTracks()) t.stop();
      streamRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setPhase("starting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This device has no camera access.");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 720 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) throw new Error("The camera preview is unavailable on this screen.");
      v.srcObject = stream;
      // A rejected play() is not fatal by itself — a WebView can refuse the promise and still
      // render the stream — so the frame check below, not this call, decides whether we are live.
      await v.play().catch(() => {});
      if (!(await waitForFrame(v))) {
        throw new Error("The camera opened but never sent a frame. Try again, or reopen the app.");
      }
      setPhase("live");
    } catch (err) {
      stopStream();
      setPhase("error");
      setError(
        err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")
          ? "Camera permission denied. Allow camera access to scan your face."
          : err instanceof Error
            ? err.message
            : "Could not open the camera.",
      );
    }
  }, [stopStream]);

  const capture = useCallback(() => {
    const v = videoRef.current;
    // Never fail silently here. This used to `return` on a not-yet-ready frame, so a tap on
    // "Capture face" in a WebView that had not produced one did nothing at all — no photo, no
    // error, no state change — which is indistinguishable from a dead button.
    if (!v || !v.videoWidth) {
      setError("The camera hasn't sent a frame yet. Wait a second, then tap Capture face again.");
      return;
    }
    // Centre-crop the video to a square, then downscale to OUT. Mirror horizontally so the stored
    // image matches the mirrored preview the user was aligning to.
    const side = Math.min(v.videoWidth, v.videoHeight);
    const sx = (v.videoWidth - side) / 2;
    const sy = (v.videoHeight - side) / 2;
    const canvas = document.createElement("canvas");
    canvas.width = OUT;
    canvas.height = OUT;
    const g = canvas.getContext("2d");
    if (!g) return;
    g.translate(OUT, 0);
    g.scale(-1, 1);
    g.drawImage(v, sx, sy, side, side, 0, 0, OUT, OUT);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.86);
    setShot(dataUrl);
    // `saveFace` swallows quota/privacy-mode failures and reports them as `false`. The capture is
    // still good, but the dashboard reads the face back from storage, so an unsaved one means an
    // empty hero later — say so now instead of letting it look like the scan didn't count.
    const saved = saveFace(address, dataUrl);
    setError(saved ? null : "Captured, but this device wouldn't store it, so your dashboard face won't persist.");
    onCaptured?.(dataUrl);
    stopStream();
    setPhase("captured");
  }, [address, onCaptured, stopStream]);

  const retake = useCallback(() => {
    setShot(null);
    void start();
  }, [start]);

  // Always release the camera when this component goes away.
  useEffect(() => () => stopStream(), [stopStream]);

  return (
    <div data-testid="face-capture" className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="eyebrow">Scan your face</span>
        <span className="font-mono text-2xs text-graphite">worn as your score</span>
      </div>

      {/* Framing stage — the oval guide the user aligns to. */}
      <div
        className="relative mx-auto overflow-hidden"
        style={{ width: 220, height: 220, borderRadius: "50%", background: "var(--color-paper-2)" }}
      >
        {phase === "captured" && shot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shot} alt="Your captured face" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <video
            ref={videoRef}
            playsInline
            muted
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: "scaleX(-1)", // mirror, so it reads like a mirror not a camera
              display: phase === "live" || phase === "starting" ? "block" : "none",
            }}
          />
        )}

        {phase === "idle" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-graphite">
            <FaceGlyph />
            <span className="text-2xs">Tap start, centre your face</span>
          </div>
        ) : null}
        {phase === "starting" ? (
          <div className="absolute inset-0 flex items-center justify-center text-2xs text-graphite">Opening camera…</div>
        ) : null}

        {/* Alignment ring, only while live. */}
        {phase === "live" ? (
          <div
            aria-hidden
            className="pointer-events-none absolute"
            style={{ inset: 10, borderRadius: "50%", border: "2px dashed rgba(255,255,255,0.7)" }}
          />
        ) : null}
      </div>

      {error ? (
        <p className="mt-3 text-center text-2xs" style={{ color: "var(--color-protest)" }} data-testid="face-capture-error">
          {error}
        </p>
      ) : null}

      {/* Confirm the capture in words. The only other change on capture is the oval swapping to a
          still and this button becoming "Retake", which on a phone reads as nothing having
          happened — the step's own CTA sits further down the page, off-screen. */}
      {phase === "captured" && !error ? (
        <p className="mt-3 text-center text-2xs text-graphite" data-testid="face-capture-saved">
          Face saved — continue below.
        </p>
      ) : null}

      <div className="mt-4">
        {phase === "idle" || phase === "error" ? (
          <button type="button" onClick={() => void start()} className="btn btn-primary btn-block">
            {phase === "error" ? "Try again" : "Start camera"}
          </button>
        ) : null}
        {phase === "starting" ? (
          <button type="button" disabled className="btn btn-primary btn-block">
            Opening…
          </button>
        ) : null}
        {phase === "live" ? (
          <button type="button" onClick={capture} className="btn btn-accent btn-block" data-testid="face-capture-shoot">
            Capture face
          </button>
        ) : null}
        {phase === "captured" ? (
          <button type="button" onClick={retake} className="btn btn-secondary btn-block" data-testid="face-capture-retake">
            Retake
          </button>
        ) : null}
      </div>
    </div>
  );
}

function FaceGlyph() {
  return (
    <svg width="40" height="40" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <circle cx="20" cy="20" r="14" stroke="currentColor" strokeWidth="1.5" opacity="0.6" />
      <circle cx="15" cy="17" r="1.6" fill="currentColor" />
      <circle cx="25" cy="17" r="1.6" fill="currentColor" />
      <path d="M15 25c2 2 8 2 10 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}
