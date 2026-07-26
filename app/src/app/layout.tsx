import type { Metadata, Viewport } from "next";
import { Montserrat, Karla, IBM_Plex_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Providers } from "./providers";
import "./globals.css";

// Type pairing: Montserrat — geometric sans — for display headings, over Karla, a friendly grotesque
// that holds the app's dense 13px body and labels. IBM Plex Mono stays for IDs & figures. Karla keeps
// the --font-space variable name so the token layer in globals.css is untouched; Montserrat rides on
// --font-display and is applied to headings.
const spaceGrotesk = Karla({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-space",
  display: "swap",
});

const montserrat = Montserrat({
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  variable: "--font-mont",
  display: "swap",
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-plex",
  display: "swap",
});

export const metadata: Metadata = {
  title: "VouchMe",
  description: "Proof of human is a floor. VouchMe is the ladder.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${montserrat.variable} ${plexMono.variable}`}>
      <body className="min-h-screen bg-void text-cream">
        <Providers>{children}</Providers>
        {/* film-grain veil over the whole app — gives flat white surfaces tooth. Decorative only. */}
        <div className="grain-overlay" aria-hidden />
      </body>
    </html>
  );
}
