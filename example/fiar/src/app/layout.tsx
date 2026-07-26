import type { Metadata, Viewport } from "next";
import { Archivo, Courier_Prime } from "next/font/google";
import type { ReactNode } from "react";
import "./globals.css";

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "800"],
  variable: "--font-archivo",
  display: "swap",
});

const courierPrime = Courier_Prime({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-courier-prime",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Fiar — borrow from neighbours",
  description: "Borrow things from people nearby. Your standing sets the deposit, not your bank balance.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#d9ded4",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${courierPrime.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
