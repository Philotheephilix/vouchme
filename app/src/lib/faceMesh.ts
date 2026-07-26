import * as THREE from "three";
import { TRIANGULATION } from "./faceTriangulation";
import type { FaceLandmarks } from "./faceScan";

/**
 * faceMesh — turns MediaPipe face landmarks into real 3D face geometry.
 *
 * This is the piece that replaced the old "egg": instead of faking depth with an elliptical dome
 * over a flat photo, the face is the actual 468-point mesh MediaPipe reconstructs, with true
 * per-vertex depth (p.z) and the canonical face triangulation. `FaceMesh` surface-samples this into
 * its particle cloud, so the hero is a real front-facing face, not a rounded shell.
 *
 * Ported from the World-circle reference; the .glb exporter was dropped (VouchMe stores the compact
 * geometry in localStorage, it never needs a downloadable model).
 */

/** A captured webcam frame's pixels, used to color the mesh realistically. */
export interface FaceFrame {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** One captured pose: landmarks + the webcam pixels at that moment. */
export interface CaptureShot {
  landmarks: FaceLandmarks;
  frame: FaceFrame;
}

/**
 * Build the face geometry from multiple captured angles. Positions come from the first (frontal)
 * shot; per-vertex color is merged across all shots, weighted by how front-facing each vertex is in
 * each shot. Because MediaPipe tracks the same 468 landmarks in every pose, a side shot colors
 * exactly the cheek/ear/nose-side points the frontal shot lights poorly — no pose math, just 2D
 * triangle winding to detect occlusion.
 */
export function landmarksToGeometryMulti(shots: CaptureShot[]): THREE.BufferGeometry {
  const front = shots[0];
  const count = front.landmarks.length;
  const positions = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const p = front.landmarks[i];
    positions[i * 3 + 0] = 0.5 - p.x; // mirror horizontally (selfie)
    positions[i * 3 + 1] = 0.5 - p.y; // flip so up is +Y
    positions[i * 3 + 2] = -(p.z ?? 0); // depth toward camera
  }

  const colors = mergeVertexColors(shots, count);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(TRIANGULATION);
  normalizeGeometry(geometry);
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * Rebuild a geometry from already-normalized positions + colors (the form persisted in faceStore).
 * Used on the render side so `FaceMesh` never has to re-run MediaPipe — the 468-vertex form is
 * captured once at enrollment and replayed from storage.
 */
export function geometryFromArrays(positions: Float32Array, colors: Float32Array): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(TRIANGULATION);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function mergeVertexColors(shots: CaptureShot[], count: number): Float32Array {
  const num = new Float32Array(count * 3);
  const den = new Float32Array(count);
  const triCount = TRIANGULATION.length / 3;

  for (const shot of shots) {
    const lm = shot.landmarks;
    const ref = frontSign(lm);

    // per-vertex front-facing fraction from adjacent triangles
    const vis = new Float32Array(count);
    const adj = new Float32Array(count);
    for (let t = 0; t < triCount; t++) {
      const a = TRIANGULATION[t * 3];
      const b = TRIANGULATION[t * 3 + 1];
      const c = TRIANGULATION[t * 3 + 2];
      const facing = Math.sign(signedArea(lm, a, b, c)) === ref ? 1 : 0;
      vis[a] += facing;
      vis[b] += facing;
      vis[c] += facing;
      adj[a]++;
      adj[b]++;
      adj[c]++;
    }

    for (let i = 0; i < count; i++) {
      const frac = adj[i] > 0 ? vis[i] / adj[i] : 0;
      const w = frac + 0.02; // epsilon so every vertex keeps some color
      const [r, g, b] = sampleFrame(shot.frame, lm[i].x, lm[i].y);
      num[i * 3 + 0] += r * w;
      num[i * 3 + 1] += g * w;
      num[i * 3 + 2] += b * w;
      den[i] += w;
    }
  }

  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    if (den[i] > 0) {
      colors[i * 3 + 0] = num[i * 3 + 0] / den[i];
      colors[i * 3 + 1] = num[i * 3 + 1] / den[i];
      colors[i * 3 + 2] = num[i * 3 + 2] / den[i];
    } else {
      colors[i * 3 + 0] = 0.87;
      colors[i * 3 + 1] = 0.9;
      colors[i * 3 + 2] = 0.83;
    }
  }
  return colors;
}

/** Signed area of a landmark triangle in image space (winding sign). */
function signedArea(lm: FaceLandmarks, a: number, b: number, c: number): number {
  const ax = lm[a].x,
    ay = lm[a].y;
  const bx = lm[b].x,
    by = lm[b].y;
  const cx = lm[c].x,
    cy = lm[c].y;
  return (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
}

/** Dominant winding sign across the whole mesh = the front-facing reference. */
function frontSign(lm: FaceLandmarks): number {
  let s = 0;
  const triCount = TRIANGULATION.length / 3;
  for (let t = 0; t < triCount; t++) {
    s += signedArea(lm, TRIANGULATION[t * 3], TRIANGULATION[t * 3 + 1], TRIANGULATION[t * 3 + 2]);
  }
  return Math.sign(s) || 1;
}

function sampleFrame(frame: FaceFrame, x: number, y: number): [number, number, number] {
  const px = Math.min(frame.width - 1, Math.max(0, Math.floor(x * frame.width)));
  const py = Math.min(frame.height - 1, Math.max(0, Math.floor(y * frame.height)));
  const i = (py * frame.width + px) * 4;
  return [frame.data[i] / 255, frame.data[i + 1] / 255, frame.data[i + 2] / 255];
}

/** Center on centroid and scale so the largest dimension spans ~`targetSize` units. */
export function normalizeGeometry(geometry: THREE.BufferGeometry, targetSize = 3): void {
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const center = new THREE.Vector3();
  box.getCenter(center);
  const size = new THREE.Vector3();
  box.getSize(size);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;
  const scale = targetSize / maxDim;

  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    pos.setXYZ(
      i,
      (pos.getX(i) - center.x) * scale,
      (pos.getY(i) - center.y) * scale,
      (pos.getZ(i) - center.z) * scale,
    );
  }
  pos.needsUpdate = true;
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
}
