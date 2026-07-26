import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `next build` and `next dev` write the same artefacts to the same place, so building while a
  // dev server is up leaves it looking for vendor chunks the build already replaced — it 500s with
  // "Cannot find module ./vendor-chunks/viem.js" and nothing about the message says why. The build
  // script points this at .next-build so the two can coexist.
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  // The floating dev badge sits on top of the pool list at phone width, which is the only width
  // this app is ever seen at.
  devIndicators: false,
  // World App renders mini apps in a webview under its own origin, so the dev server has to accept
  // it as a cross-origin caller during local testing.
  allowedDevOrigins: ["*.worldcoin.org", "*.world.org"],
};

export default nextConfig;
