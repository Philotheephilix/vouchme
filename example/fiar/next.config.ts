import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The floating dev badge sits on top of the cards in a phone-width viewport, which is the only
  // width this app is ever seen at.
  devIndicators: false,
  // World App renders mini apps in a webview under its own origin, so the dev server has to
  // accept it as a cross-origin caller during local testing.
  allowedDevOrigins: ["*.worldcoin.org", "*.world.org"],
};

export default nextConfig;
