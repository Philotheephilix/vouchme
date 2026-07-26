/**
 * faceStore — where the *scanned* face lives.
 *
 * VouchMe's home hero is a particle bust of YOUR face — the one captured during onboarding, not a
 * procedural stand-in. What's stored is the compact 468-vertex face *form* MediaPipe reconstructs
 * during the 3-shot scan (`FaceCapture`): normalized positions + merged per-vertex colors. That is
 * everything `FaceMesh` needs to surface-sample its particle cloud — a real, front-facing face with
 * true depth, not a photo faked onto a dome.
 *
 * It's personal and device-local, so it's kept in `localStorage` keyed by the lowercased wallet
 * address, never sent to a server. If nothing is stored there is deliberately NO fallback face — the
 * hero renders an empty-state, because the face must be the real one or none.
 *
 * Encoding: the two Float32 arrays are packed to base64 (little-endian bytes) so the whole form is
 * ~15 KB of text — tiny for localStorage, lossless, and instant to decode. A small JPEG thumbnail of
 * the frontal shot rides along only as a WebGL-unavailable fallback still.
 */

const PREFIX = "vouchme:face:";
const VERSION = 2;

export interface FaceForm {
  /** normalized 468×3 vertex positions (largest dim ≈ 3 units, centred) */
  positions: Float32Array;
  /** 468×3 per-vertex RGB in [0,1], merged across the captured angles */
  colors: Float32Array;
  /** optional frontal-shot JPEG data URL, used only for the non-WebGL fallback still */
  thumb?: string;
}

interface StoredFace {
  v: number;
  positions: string; // base64 Float32
  colors: string; // base64 Float32
  thumb?: string;
}

function keyFor(address: string): string {
  return PREFIX + address.trim().toLowerCase();
}

function f32ToBase64(arr: Float32Array): string {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToF32(b64: string): Float32Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  // copy into a fresh, correctly-aligned buffer before viewing as Float32
  return new Float32Array(bytes.buffer.slice(0));
}

/** Persist a captured face form for an address. No-op / false on SSR or quota failure. */
export function saveFace(address: string, form: FaceForm): boolean {
  if (typeof window === "undefined" || !address) return false;
  try {
    const payload: StoredFace = {
      v: VERSION,
      positions: f32ToBase64(form.positions),
      colors: f32ToBase64(form.colors),
      thumb: form.thumb,
    };
    window.localStorage.setItem(keyFor(address), JSON.stringify(payload));
    return true;
  } catch {
    // Quota or privacy-mode block — the capture simply won't persist; not fatal.
    return false;
  }
}

/** Load the stored face form for an address, or null when none / unavailable / stale-format. */
export function loadFace(address: string): FaceForm | null {
  if (typeof window === "undefined" || !address) return null;
  try {
    const raw = window.localStorage.getItem(keyFor(address));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredFace;
    if (parsed.v !== VERSION || !parsed.positions || !parsed.colors) return null;
    return {
      positions: base64ToF32(parsed.positions),
      colors: base64ToF32(parsed.colors),
      thumb: parsed.thumb,
    };
  } catch {
    return null;
  }
}

/** True when a scanned face exists for this address. */
export function hasFace(address: string): boolean {
  if (typeof window === "undefined" || !address) return false;
  try {
    const raw = window.localStorage.getItem(keyFor(address));
    if (!raw) return false;
    const parsed = JSON.parse(raw) as StoredFace;
    return parsed.v === VERSION && !!parsed.positions;
  } catch {
    return false;
  }
}

/** Forget a stored face (e.g. a re-scan that replaces it, or account switch). */
export function clearFace(address: string): void {
  if (typeof window === "undefined" || !address) return;
  try {
    window.localStorage.removeItem(keyFor(address));
  } catch {
    // ignore
  }
}
