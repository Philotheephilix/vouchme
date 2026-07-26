"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * EthCoin — a real-time 3D Ethereum coin, spinning slowly on a transparent canvas. Used as the hero
 * object on the sign-in cover, where a bold rotating token sets the on-chain tone before any app
 * data loads. Rendered with raw three.js to match FaceMesh's approach (the app carries `three` but
 * no react-three wrapper).
 *
 * The model is metallic PBR, so it needs an environment to reflect — a `RoomEnvironment` baked
 * through `PMREMGenerator` gives it studio highlights without shipping an HDR asset. The 28 MB glTF
 * is fetched lazily (this component is dynamically imported client-side), so it never blocks paint;
 * a faint ring placeholder holds the space until the mesh is ready.
 *
 * Model credit — CC-BY-4.0, required by the licence:
 *   "Ethereum coin" (https://sketchfab.com/3d-models/ethereum-coin-284290a75d68441a883ea7854293617b)
 *   by kanzari.design, licensed under CC-BY-4.0. See public/models/ethereum_coin/license.txt.
 */
export function EthCoin({ size = 140, className, style }: { size?: number; className?: string; style?: React.CSSProperties }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof window === "undefined") return;

    const reducedMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      if (!renderer.getContext()) throw new Error("no webgl");
    } catch {
      return; // no WebGL → render nothing; the placeholder ring stays
    }

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(size, size);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.domElement.style.cssText = "width:100%;height:100%;display:block";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0, 4.2);

    // Studio environment for metallic reflections (no HDR file needed).
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRT.texture;

    // A key + rim light on top of the env so the edges catch the app's blue.
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(2, 3, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x2135c8, 1.6);
    rim.position.set(-3, -1, -2);
    scene.add(rim);
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));

    const group = new THREE.Group();
    scene.add(group);

    let raf = 0;
    let disposed = false;
    let modelRoot: THREE.Object3D | null = null;

    const loader = new GLTFLoader();
    loader.load(
      "/models/ethereum_coin/scene.gltf",
      (gltf) => {
        if (disposed) return;
        const model = gltf.scene;
        // Normalise: centre on origin and scale the longest axis to ~2 world units.
        const box = new THREE.Box3().setFromObject(model);
        const c = box.getCenter(new THREE.Vector3());
        const sz = box.getSize(new THREE.Vector3());
        model.position.sub(c);
        const fit = 2.1 / Math.max(sz.x, sz.y, sz.z);
        model.scale.setScalar(fit);
        // Tilt so it reads as a coin catching light, not a flat disc edge-on.
        group.rotation.set(0.42, 0, 0.08);
        group.add(model);
        modelRoot = model;
        container.replaceChildren(renderer.domElement);
        if (reducedMotion) renderer.render(scene, camera);
      },
      undefined,
      () => {
        // load failure → leave the placeholder ring in place
      },
    );

    if (!reducedMotion) {
      const clock = new THREE.Clock();
      const loop = () => {
        raf = requestAnimationFrame(loop);
        group.rotation.y = clock.getElapsedTime() * 0.45;
        renderer.render(scene, camera);
      };
      raf = requestAnimationFrame(loop);
    }

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      envRT.dispose();
      pmrem.dispose();
      if (modelRoot) {
        modelRoot.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.geometry) mesh.geometry.dispose();
          const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else if (mat) mat.dispose();
        });
      }
      renderer.dispose();
      if (renderer.domElement.parentNode === container) container.removeChild(renderer.domElement);
    };
  }, [size]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ width: size, height: size, ...style }}
      aria-hidden="true"
    >
      {/* placeholder held until the mesh loads (or if WebGL/model is unavailable) */}
      <div
        style={{
          width: "100%",
          height: "100%",
          borderRadius: "50%",
          border: "2px dashed color-mix(in oklab, var(--color-accent) 30%, transparent)",
        }}
      />
    </div>
  );
}
