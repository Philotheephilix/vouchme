"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { detectFace, getFaceLandmarker, type FaceLandmarks } from "@/lib/faceScan";
import { landmarksToGeometryMulti, type CaptureShot } from "@/lib/faceMesh";
import { saveFace } from "@/lib/faceStore";

/**
 * FaceCapture — the onboarding step that scans the face the home hero (`FaceMesh`) is built from. It
 * is the ONLY source of that face; there is no default.
 *
 * Unlike the old single-photo capture (which faked depth by draping a still over a dome — the
 * "egg"), this runs MediaPipe FaceLandmarker live and takes THREE angled shots: straight, slight
 * left, slight right. From those it reconstructs the real 468-point face mesh (true per-vertex
 * depth) and merges color across the angles so the sides aren't left flat. The compact form
 * (positions + colors) is persisted via `saveFace`; `FaceMesh` surface-samples it into particles.
 *
 * The camera stream is always stopped on unmount and after the final capture so the camera light
 * doesn't linger.
 */

type Phase = "idle" | "starting" | "live" | "done" | "error";
type Detection = "searching" | "detected";

const STEPS = [
  "Look straight ahead",
  "Turn your head slightly left",
  "Turn your head slightly right",
] as const;

const THUMB = 256; // fallback-still square size

export interface FaceCaptureProps {
  address: string;
  /** called once the 3-shot face has been captured and saved */
  onCaptured?: () => void;
}

export function FaceCapture({ address, onCaptured }: FaceCaptureProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const overlayRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const rafRef = useRef(0);
  const latestRef = useRef<FaceLandmarks | null>(null);
  const shotsRef = useRef<CaptureShot[]>([]);

  const [phase, setPhase] = useState<Phase>("idle");
  const [detection, setDetection] = useState<Detection>("searching");
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const stopStream = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    const s = streamRef.current;
    if (s) {
      for (const t of s.getTracks()) t.stop();
      streamRef.current = null;
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setStep(0);
    setDetection("searching");
    shotsRef.current = [];
    latestRef.current = null;
    setPhase("starting");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("This device has no camera access.");
      const landmarker = await getFaceLandmarker();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (!v) throw new Error("The camera preview is unavailable on this screen.");
      v.srcObject = stream;
      await v.play().catch(() => {});
      setPhase("live");

      const overlay = overlayRef.current;
      const ctx = overlay?.getContext("2d") ?? null;

      const loop = () => {
        rafRef.current = requestAnimationFrame(loop);
        if (v.readyState < 2 || !v.videoWidth) return;
        const landmarks = detectFace(landmarker, v, performance.now());
        latestRef.current = landmarks;
        setDetection(landmarks ? "detected" : "searching");
        if (overlay && ctx) {
          overlay.width = v.videoWidth;
          overlay.height = v.videoHeight;
          ctx.clearRect(0, 0, overlay.width, overlay.height);
          if (landmarks) drawLandmarks(ctx, landmarks, overlay.width, overlay.height);
        }
      };
      loop();
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
    const lm = latestRef.current;
    const v = videoRef.current;
    if (!lm || !v || !v.videoWidth) {
      setError("No face detected yet. Center your face in the ring, then capture.");
      return;
    }
    setError(null);

    // grab the current webcam pixels for coloring this angle
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const cx = c.getContext("2d");
    if (!cx) return;
    cx.drawImage(v, 0, 0, c.width, c.height);
    const img = cx.getImageData(0, 0, c.width, c.height);

    // landmarks mutate frame-to-frame — snapshot them
    const snapshot = lm.map((p) => ({ ...p }));
    shotsRef.current.push({
      landmarks: snapshot,
      frame: { data: img.data, width: c.width, height: c.height },
    });

    if (shotsRef.current.length < STEPS.length) {
      setStep(shotsRef.current.length);
      return;
    }

    // all angles captured — reconstruct the mesh, persist the compact form
    try {
      const geo = landmarksToGeometryMulti(shotsRef.current);
      const positions = new Float32Array((geo.getAttribute("position") as { array: ArrayLike<number> }).array);
      const colors = new Float32Array((geo.getAttribute("color") as { array: ArrayLike<number> }).array);
      const thumb = makeThumb(shotsRef.current[0]);
      geo.dispose();
      const saved = saveFace(address, { positions, colors, thumb });
      setError(
        saved ? null : "Captured, but this device wouldn't store it, so your dashboard face won't persist.",
      );
    } catch {
      setError("Couldn't build the face from those shots. Retake and keep your whole face in frame.");
      shotsRef.current = [];
      setStep(0);
      return;
    }

    stopStream();
    setPhase("done");
    onCaptured?.();
  }, [address, onCaptured, stopStream]);

  const retake = useCallback(() => {
    void start();
  }, [start]);

  useEffect(() => () => stopStream(), [stopStream]);

  const live = phase === "live";
  const lastStep = step === STEPS.length - 1;

  return (
    <div data-testid="face-capture" className="card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="eyebrow">Scan your face</span>
        <span className="font-mono text-2xs text-graphite">worn as your score</span>
      </div>

      {/* Framing stage — mirrored live preview + landmark overlay, aligned inside the ring. */}
      <div
        className="relative mx-auto overflow-hidden"
        style={{ width: 220, height: 220, borderRadius: "50%", background: "var(--color-paper-2)" }}
      >
        <video
          ref={videoRef}
          playsInline
          muted
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            transform: "scaleX(-1)", // mirror, so it reads like a mirror not a camera
            display: live || phase === "starting" ? "block" : "none",
          }}
        />
        <canvas
          ref={overlayRef}
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ width: "100%", height: "100%", transform: "scaleX(-1)", display: live ? "block" : "none" }}
        />

        {phase === "idle" || phase === "error" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-graphite">
            <FaceGlyph />
            <span className="text-2xs">Tap start, center your face</span>
          </div>
        ) : null}
        {phase === "starting" ? (
          <div className="absolute inset-0 flex items-center justify-center text-2xs text-graphite">
            Opening camera…
          </div>
        ) : null}
        {phase === "done" ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-graphite">
            <FaceGlyph />
            <span className="text-2xs">Face captured</span>
          </div>
        ) : null}

        {/* Alignment ring, only while live. */}
        {live ? (
          <div
            aria-hidden
            className="pointer-events-none absolute"
            style={{ inset: 10, borderRadius: "50%", border: "2px dashed rgba(255,255,255,0.7)" }}
          />
        ) : null}
      </div>

      {/* Step guidance while live. */}
      {live ? (
        <div className="mt-3 text-center" data-testid="face-capture-step">
          <p className="font-mono text-2xs uppercase tracking-wide text-graphite">
            Shot {step + 1} of {STEPS.length}
          </p>
          <p className="mt-0.5 text-sm text-cream">{STEPS[step]}</p>
          <div className="mt-2 flex justify-center gap-1.5">
            {STEPS.map((_, i) => (
              <span
                key={i}
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: i < step ? "var(--color-accent, #7b7ff0)" : "var(--color-rule-strong)",
                }}
              />
            ))}
          </div>
        </div>
      ) : null}

      {error ? (
        <p
          className="mt-3 text-center text-2xs"
          style={{ color: "var(--color-protest)" }}
          data-testid="face-capture-error"
        >
          {error}
        </p>
      ) : null}

      {phase === "done" && !error ? (
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
        {live ? (
          <button
            type="button"
            onClick={capture}
            disabled={detection !== "detected"}
            className="btn btn-accent btn-block"
            data-testid="face-capture-shoot"
          >
            {detection === "detected"
              ? lastStep
                ? "Capture & build"
                : "Capture this angle"
              : "Align your face…"}
          </button>
        ) : null}
        {phase === "done" ? (
          <button
            type="button"
            onClick={retake}
            className="btn btn-secondary btn-block"
            data-testid="face-capture-retake"
          >
            Rescan
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Small mirrored JPEG of the frontal shot, kept only as a non-WebGL fallback still. */
function makeThumb(shot: CaptureShot): string | undefined {
  try {
    const { data, width, height } = shot.frame;
    const src = document.createElement("canvas");
    src.width = width;
    src.height = height;
    const sctx = src.getContext("2d");
    if (!sctx) return undefined;
    sctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);

    const side = Math.min(width, height);
    const sx = (width - side) / 2;
    const sy = (height - side) / 2;
    const out = document.createElement("canvas");
    out.width = THUMB;
    out.height = THUMB;
    const octx = out.getContext("2d");
    if (!octx) return undefined;
    octx.translate(THUMB, 0);
    octx.scale(-1, 1); // mirror to match the preview
    octx.drawImage(src, sx, sy, side, side, 0, 0, THUMB, THUMB);
    return out.toDataURL("image/jpeg", 0.85);
  } catch {
    return undefined;
  }
}

function drawLandmarks(ctx: CanvasRenderingContext2D, landmarks: FaceLandmarks, w: number, h: number) {
  ctx.fillStyle = "rgba(123,127,240,0.85)"; // app accent indigo
  for (let i = 0; i < landmarks.length; i++) {
    const p = landmarks[i];
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }
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
