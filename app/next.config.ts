import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,

  // Build output directory, overridable per process.
  //
  // The long-running dev server and a `next build` run cannot share one output
  // directory: `build` rewrites .next while `dev` is reading it, and requests
  // start failing with ENOENT on routes-manifest.json — which looks like a
  // broken app rather than two writers racing over one directory.
  //
  // So the containerised dev server runs with NEXT_DIST_DIR=.next-dev and
  // production builds keep the default .next. Both can run at once.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
