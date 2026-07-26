"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { MeshSurfaceSampler } from "three/addons/math/MeshSurfaceSampler.js";
import { loadFace, type FaceForm } from "@/lib/faceStore";
import { geometryFromArrays } from "@/lib/faceMesh";

/**
 * FaceMesh — a reputation-driven particle bust of the user's OWN scanned face.
 *
 * The target shape is the REAL 468-point face mesh MediaPipe reconstructed during the 3-shot
 * onboarding scan (`FaceCapture` → `faceStore`), surface-sampled into particles. This is what killed
 * the old "egg": there is no faked dome-depth anymore — the particles sit on the true face surface
 * (real per-vertex depth), so the hero reads as a front-facing face, not a rounded shell. If no face
 * has been scanned for this address, the hero renders an explicit empty-state — there is
 * deliberately no default/fallback face. The face is the real one or none.
 *
 * The particle system (snoise/curl vertex shader, scatter→target coherence lerp, pointer influence)
 * keeps VouchMe's treatment:
 *   1. Light theme — dark points on a transparent canvas, glow is the app accent indigo.
 *   2. Colour is sampled from the real mesh's per-vertex colour (merged across the capture angles),
 *      darkened so it reads on the pale surface and pushed toward graphite as it recedes so the
 *      silhouette holds.
 *   3. Reputation coherence — `score`/`tier`/`isAnchor` set how *formed* the face is; a low-standing
 *      identity is a loose granule-face, a high one is crisp. It never fully dissolves: the face
 *      stays findable at every tier.
 */

export interface FaceMeshProps {
  address: string;
  score: number;
  tier: 0 | 1 | 2;
  isAnchor?: boolean;
  /** rendered pixel height of the canvas box; default ~260 */
  height?: number;
  className?: string;
}

// --- palette (light theme) -------------------------------------------------
const INK = 0x14161a; // near-black, the darkest points
const GRAPHITE = 0x8b8f9a; // muted grey, points that recede toward the back
const GLOW = 0x7b7ff0; // app accent indigo, only under pointer influence

const TIER1_SCORE = 55;
const TIER2_SCORE = 140;

const N = 42000; // particle count
const FACE_SCALE = 0.78; // shrink the size-3 normalized mesh to the hero's framing

/** Seedable PRNG so the scatter field is deterministic per address. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashAddress(address: string): number {
  let h = 0x811c9dc5;
  const s = address.toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Reputation → coherence in [0..1] (how "formed" the face is). Floors are high on purpose: a
 * brand-new Tier-0 identity must still read as a FACE, not a dust cloud.
 */
function coherenceFor(score: number, tier: 0 | 1 | 2, isAnchor: boolean): number {
  if (isAnchor) return 1;
  let c: number;
  if (score <= 0) {
    c = 0.55;
  } else if (score <= TIER1_SCORE) {
    c = 0.55 + (score / TIER1_SCORE) * 0.27; // → 0.82 at Tier 1
  } else {
    const over = (score - TIER1_SCORE) / (TIER2_SCORE - TIER1_SCORE);
    c = 0.82 + (1 - Math.exp(-1.6 * over)) * 0.18; // → ~1.0
  }
  c += tier * 0.02;
  return Math.max(0, Math.min(1, c));
}

const vertexShader = `
attribute vec3 aScatter; attribute vec3 aColor; attribute float aSeed;
uniform float uTime, uCoherence, uSize, uPixelRatio, uMouseStrength;
uniform vec3 uMouse; varying vec3 vColor; varying float vGlow;
vec4 permute(vec4 x){return mod(((x*34.0)+1.0)*x,289.0);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){const vec2 C=vec2(1.0/6.0,1.0/3.0);const vec4 D=vec4(0.0,0.5,1.0,2.0);
 vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.0-g;
 vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+2.0*C.xxx;
 vec3 x3=x0-1.0+3.0*C.xxx;i=mod(i,289.0);
 vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
 float n_=1.0/7.0;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.0*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);
 vec4 y_=floor(j-7.0*x_);vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.0-abs(x)-abs(y);
 vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.0+1.0;vec4 s1=floor(b1)*2.0+1.0;
 vec4 sh=-step(h,vec4(0.0));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
 vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
 vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
 p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
 vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);m=m*m;
 return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
vec3 curl(vec3 p){return vec3(snoise(p),snoise(p+vec3(31.4,0.0,11.7)),snoise(p+vec3(0.0,47.2,23.9)));}
float ease(float x){return x*x*x*(x*(x*6.0-15.0)+10.0);}
void main(){
 float coh=ease(clamp(uCoherence,0.0,1.0));
 vec3 base=mix(aScatter,position,coh);
 vec3 toP=base-uMouse;float d=length(toP);float infl=smoothstep(0.8,0.0,d)*uMouseStrength;
 vec3 pushed=base+normalize(toP+vec3(1e-4))*infl*0.28;
 vec3 np=pushed*0.5+vec3(0.0,0.0,uTime*0.22)+aSeed;
 float amp=0.62*(1.0-coh)+0.02+infl*0.28;
 vec3 disp=pushed+curl(np)*amp;
 vec4 mv=modelViewMatrix*vec4(disp,1.0);gl_Position=projectionMatrix*mv;
 gl_PointSize=uSize*uPixelRatio*(7.0/-mv.z);
 vColor=aColor;vGlow=infl;}
`;

const fragmentShader = `precision highp float;uniform vec3 uGlowColor;varying vec3 vColor;varying float vGlow;
void main(){vec2 uv=gl_PointCoord-vec2(0.5);float d=length(uv);if(d>0.5)discard;
 float a=smoothstep(0.5,0.05,d);vec3 c=mix(vColor,uGlowColor,vGlow*0.6);
 gl_FragColor=vec4(c,a);}`;

/**
 * Surface-sample the real face mesh into 3D particle targets + per-particle colours.
 *
 * Each particle lands on a random point of the face surface (uniform by area) and takes the mesh's
 * interpolated colour there. For the light theme the colour is darkened and pushed toward graphite as
 * the point recedes in depth, so the silhouette holds against the pale page rather than dissolving.
 */
function buildFace(count: number, form: FaceForm): { target: Float32Array; colors: Float32Array } {
  const target = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  const geo = geometryFromArrays(form.positions, form.colors);
  const mesh = new THREE.Mesh(geo);
  // deterministic sampling: MeshSurfaceSampler takes an optional RNG
  const sampler = new MeshSurfaceSampler(mesh).setWeightAttribute(null).build();

  // depth range for the recede-toward-graphite shading
  geo.computeBoundingBox();
  const bb = geo.boundingBox!;
  const zMin = bb.min.z;
  const zSpan = Math.max(1e-4, bb.max.z - bb.min.z);

  const graphite = new THREE.Color(GRAPHITE);
  const ink = new THREE.Color(INK);
  const p = new THREE.Vector3();
  const col = new THREE.Color();

  for (let i = 0; i < count; i++) {
    sampler.sample(p, undefined, col);

    target[i * 3] = p.x * FACE_SCALE;
    target[i * 3 + 1] = p.y * FACE_SCALE;
    target[i * 3 + 2] = p.z * FACE_SCALE;

    const depth = (p.z - zMin) / zSpan; // 0 = back, 1 = front
    const edge = 1 - depth;
    // photo colour darkened for the light surface; recede toward graphite/ink at the back
    col.setRGB(col.r * 0.55, col.g * 0.55, col.b * 0.55);
    col.lerp(graphite, edge * 0.45).lerp(ink, edge * 0.12);
    colors[i * 3] = col.r;
    colors[i * 3 + 1] = col.g;
    colors[i * 3 + 2] = col.b;
  }

  geo.dispose();
  return { target, colors };
}

export function FaceMesh({ address, score, tier, isAnchor = false, height = 260, className }: FaceMeshProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof window === "undefined") return;

    // The face must be the scanned one. No scan → explicit empty-state, never a default face.
    const form = loadFace(address);
    if (!form) {
      renderEmpty(container, height);
      return () => {
        container.replaceChildren();
      };
    }

    container.replaceChildren();
    const teardown = initScene(container, form, { address, score, tier, isAnchor, height });

    return () => {
      teardown();
      container.replaceChildren();
    };
  }, [address, score, tier, isAnchor, height]);

  return (
    <div ref={containerRef} className={className} style={{ width: "100%", height }} aria-hidden="true" />
  );
}

/** Build the WebGL particle scene from a stored face form. Returns a teardown fn. */
function initScene(
  container: HTMLElement,
  form: FaceForm,
  { address, score, tier, isAnchor, height }: { address: string; score: number; tier: 0 | 1 | 2; isAnchor: boolean; height: number },
): () => void {
  const seed = hashAddress(address);
  const targetCoherence = coherenceFor(score, tier, isAnchor);
  const reducedMotion =
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    if (!renderer.getContext()) throw new Error("no webgl context");
  } catch {
    renderStaticImage(container, form, height);
    return () => container.replaceChildren();
  }

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(pixelRatio);
  renderer.setClearColor(0x000000, 0);
  const width = container.clientWidth || 1;
  renderer.setSize(width, height);
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 100);
  camera.position.set(0, 0.15, 5.2);
  const group = new THREE.Group();
  scene.add(group);

  const rng = mulberry32(seed);
  const { target, colors } = buildFace(N, form);

  const scatter = new Float32Array(N * 3);
  const seeds = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // tight scatter field so even the loosest state hugs the face
    const rr = 1.7 * Math.cbrt(rng());
    const st = rng() * Math.PI * 2;
    const sp = Math.acos(2 * rng() - 1);
    scatter[i * 3] = rr * Math.sin(sp) * Math.cos(st);
    scatter[i * 3 + 1] = rr * Math.sin(sp) * Math.sin(st);
    scatter[i * 3 + 2] = rr * Math.cos(sp);
    seeds[i] = rng() * 100;
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(target, 3));
  geo.setAttribute("aScatter", new THREE.BufferAttribute(scatter, 3));
  geo.setAttribute("aColor", new THREE.BufferAttribute(colors, 3));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

  const uniforms: Record<string, THREE.IUniform> = {
    uTime: { value: 0 },
    uCoherence: { value: reducedMotion ? targetCoherence : Math.min(0.55, targetCoherence) },
    uSize: { value: 1.7 + tier * 0.15 },
    uPixelRatio: { value: pixelRatio },
    uMouse: { value: new THREE.Vector3(0, 0, 999) },
    uMouseStrength: { value: 0 },
    uGlowColor: { value: new THREE.Color(GLOW) },
  };

  const mat = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    uniforms,
  });
  const points = new THREE.Points(geo, mat);
  group.add(points);

  const canvas = renderer.domElement;
  canvas.style.pointerEvents = "auto";
  const pointer = new THREE.Vector3(0, 0, 999);
  let pStrength = 0;
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    pointer.set(
      (((e.clientX - r.left) / r.width) * 2 - 1) * 2.0,
      (-((e.clientY - r.top) / r.height) * 2 + 1) * 2.0,
      0.4,
    );
    pStrength = 0.5;
  };
  const onLeave = () => {
    pStrength = 0;
  };

  const resize = () => {
    const w = container.clientWidth || 1;
    renderer.setSize(w, height);
    camera.aspect = w / height;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(container);

  const clock = new THREE.Clock();
  let raf = 0;
  let t0: number | null = null;

  if (reducedMotion) {
    uniforms.uCoherence.value = targetCoherence;
    renderer.render(scene, camera);
  } else {
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);

    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop);
      if (t0 === null) t0 = ts;
      const e = (ts - t0) / 1000;
      const dt = Math.min(clock.getDelta(), 0.1);
      // ease coherence from an already-legible floor up to the reputation target over ~2s
      const a = Math.min(1, e / 2.0);
      const start = Math.min(0.55, targetCoherence);
      uniforms.uCoherence.value = start + (targetCoherence - start) * (a * a * (3 - 2 * a));
      uniforms.uTime.value = clock.elapsedTime;
      (uniforms.uMouse.value as THREE.Vector3).copy(pointer);
      uniforms.uMouseStrength.value =
        (uniforms.uMouseStrength.value as number) +
        (pStrength - (uniforms.uMouseStrength.value as number)) * (1 - Math.exp(-4 * dt));
      group.rotation.y = Math.sin(clock.elapsedTime * 0.35) * 0.26;
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(loop);
  }

  return () => {
    if (raf) cancelAnimationFrame(raf);
    ro.disconnect();
    canvas.removeEventListener("pointermove", onMove);
    canvas.removeEventListener("pointerleave", onLeave);
    geo.dispose();
    mat.dispose();
    renderer.dispose();
    if (canvas.parentNode === container) container.removeChild(canvas);
  };
}

/**
 * Empty-state — shown ONLY when there is no scanned face for this address. Deliberately not a face:
 * a faint dashed ring and a one-line prompt, so nobody mistakes a stand-in for a real scan.
 */
function renderEmpty(container: HTMLElement, height: number): void {
  container.replaceChildren();
  const box = document.createElement("div");
  box.style.cssText = `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;width:100%;height:${height}px;color:var(--color-graphite)`;
  const ring = document.createElement("div");
  ring.style.cssText =
    "width:120px;height:120px;border-radius:50%;border:2px dashed var(--color-rule-strong)";
  const label = document.createElement("div");
  label.style.cssText = "font-size:11px;letter-spacing:.02em";
  label.textContent = "No face scanned yet";
  box.appendChild(ring);
  box.appendChild(label);
  container.appendChild(box);
}

/** WebGL-unavailable fallback: show the frontal-shot still if one was stored, else the empty-state. */
function renderStaticImage(container: HTMLElement, form: FaceForm, height: number): void {
  container.replaceChildren();
  if (!form.thumb) {
    renderEmpty(container, height);
    return;
  }
  const el = document.createElement("img");
  el.src = form.thumb;
  el.alt = "";
  el.setAttribute("aria-hidden", "true");
  el.style.cssText = `display:block;margin:0 auto;height:${height}px;width:${height}px;object-fit:cover;border-radius:50%;opacity:.9`;
  container.appendChild(el);
}
