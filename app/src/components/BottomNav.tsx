"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useAuth } from "@/lib/session";

/** Shared royal-blue accent — softened in the nav: the active glyph and label carry the blue, the
 *  pill behind them is only a faint wash so it never shouts. */
const ACCENT = "var(--color-accent)";
const RING = "color-mix(in srgb, var(--color-accent) 20%, transparent)";
const WASH = "color-mix(in oklab, var(--color-accent) 9%, transparent)";
const EASE = "cubic-bezier(.22,1,.36,1)"; // ease-out-quint, smooth decel

/** lucide-style line icons, 1.5px stroke, currentColor — no icon dependency pulled in for four glyphs. */
const ICON: Record<string, ReactNode> = {
  home: <path d="M3 10.5 12 3l9 7.5M5 9.5V20h14V9.5" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  vouch: <path d="m4 12 5 5 11-11" />,
  profile: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 3.6-6.5 8-6.5S20 16 20 20" />
    </>
  ),
};

/** Four items, not five — Explore and Reports live under Profile. A floating glass capsule: tabs
 *  rest as bare icons; the active one grows into a soft accent pill and reveals its label. */
export function BottomNav() {
  const pathname = usePathname();
  const { address } = useAuth();

  const items = [
    { href: "/", label: "Home", icon: "home", testid: "nav-home", active: pathname === "/" },
    { href: "/search", label: "Search", icon: "search", testid: "nav-search", active: pathname.startsWith("/search") },
    { href: "/vouch", label: "Vouch", icon: "vouch", testid: "nav-vouch", active: pathname.startsWith("/vouch") },
    {
      href: address ? `/profile/${address}` : "/enroll",
      label: "Profile",
      icon: "profile",
      testid: "nav-profile",
      active: pathname.startsWith("/profile") || pathname.startsWith("/agents"),
    },
  ];

  return (
    <nav
      data-testid="bottom-nav"
      className="fixed inset-x-0 bottom-0 z-50 flex justify-center"
      style={{
        padding: "0 14px 18px",
        paddingBottom: "calc(18px + env(safe-area-inset-bottom))",
        pointerEvents: "none",
      }}
    >
      {/* Floating glass capsule — auto-width, hovers over the page rather than banding across it. */}
      <div
        className="relative flex items-center overflow-hidden"
        style={{
          padding: 6,
          gap: 4,
          height: 56,
          // Apple liquid-glass material: vibrant blur lets the page bleed through; layered shadows +
          // a bright inner rim + the sheen overlay below sell it as a lit pane of glass.
          background: "linear-gradient(180deg, rgba(255,255,255,0.72), rgba(255,255,255,0.5))",
          backdropFilter: "blur(30px) saturate(185%)",
          WebkitBackdropFilter: "blur(30px) saturate(185%)",
          borderRadius: 999,
          boxShadow:
            "inset 0 1px 0.5px rgba(255,255,255,0.95)," + // bright top rim
            "inset 0 -8px 14px -10px rgba(20,22,26,0.12)," + // interior floor shadow, depth
            "inset 0 0 0 1px rgba(255,255,255,0.5)," + // glass ring
            "0 20px 40px -18px rgba(20,22,26,0.42)," + // soft cast shadow — the float
            "0 2px 6px -2px rgba(20,22,26,0.14)," + // near contact shadow
            "0 0 0 0.5px rgba(20,22,26,0.07)", // hairline definition on white
          pointerEvents: "auto",
        }}
      >
        {/* specular sheen — a diagonal glare across the top-left, the tell of a curved glass pane */}
        <span
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 999,
            background: "radial-gradient(120% 80% at 22% -30%, rgba(255,255,255,0.7), transparent 55%)",
            pointerEvents: "none",
          }}
        />

        {items.map((item) => (
          <Link
            key={item.testid}
            href={item.href}
            data-testid={item.testid}
            aria-label={item.label}
            aria-current={item.active ? "page" : undefined}
            className="relative z-10 flex items-center justify-center active:scale-90"
            style={{
              height: 44,
              padding: item.active ? "0 16px 0 13px" : "0 12px",
              borderRadius: 999,
              color: item.active ? ACCENT : "#7b808c",
              background: item.active ? WASH : "transparent",
              boxShadow: item.active ? `inset 0 0 0 1px ${RING}` : "none",
              // width/padding animate so the pill grows into place; it's a tap-triggered, one-shot
              // transition on a single 44px element — the reveal *is* the effect.
              transition: `color .3s ease, background .45s ${EASE}, padding .45s ${EASE}, box-shadow .3s ease, transform .2s ${EASE}`,
            }}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={item.active ? 2.2 : 1.9}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{
                flexShrink: 0,
                transform: item.active ? "scale(1.05)" : "none",
                transition: `transform .45s ${EASE}`,
              }}
            >
              {ICON[item.icon]}
            </svg>
            {/* label reveals only for the active tab — width animates from 0, no reflow jump */}
            <span
              style={{
                overflow: "hidden",
                whiteSpace: "nowrap",
                maxWidth: item.active ? 74 : 0,
                marginLeft: item.active ? 7 : 0,
                opacity: item.active ? 1 : 0,
                fontSize: 12.5,
                fontWeight: 750,
                letterSpacing: "-0.01em",
                transition: `max-width .45s ${EASE}, opacity .32s ease, margin-left .45s ${EASE}`,
              }}
            >
              {item.label}
            </span>
          </Link>
        ))}
      </div>
    </nav>
  );
}
