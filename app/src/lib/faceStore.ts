/**
 * faceStore — where the *scanned* face lives.
 *
 * VouchMe's home hero is a particle bust of YOUR face — the one captured during onboarding, not a
 * procedural stand-in. That image is personal and device-local, so it is kept in `localStorage`
 * keyed by the lowercased wallet address, never sent to a server. `FaceMesh` reads it to build its
 * point cloud; the enrollment capture step writes it. If nothing is stored, there is deliberately
 * NO fallback face — the hero renders an empty-state, because the face must be the real one or none.
 *
 * Stored value is a downscaled JPEG data URL (~256px). Small enough for localStorage, big enough to
 * sample tens of thousands of particles from.
 */

const PREFIX = "vouchme:face:";

function keyFor(address: string): string {
  return PREFIX + address.trim().toLowerCase();
}

/** Persist a captured face (data URL) for an address. No-op / false on SSR or quota failure. */
export function saveFace(address: string, dataUrl: string): boolean {
  if (typeof window === "undefined" || !address) return false;
  try {
    window.localStorage.setItem(keyFor(address), dataUrl);
    return true;
  } catch {
    // Quota or privacy-mode block — the capture simply won't persist; not fatal.
    return false;
  }
}

/** Load the stored face (data URL) for an address, or null when none / unavailable. */
export function loadFace(address: string): string | null {
  if (typeof window === "undefined" || !address) return null;
  try {
    return window.localStorage.getItem(keyFor(address));
  } catch {
    return null;
  }
}

/** True when a scanned face exists for this address. */
export function hasFace(address: string): boolean {
  return loadFace(address) !== null;
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
