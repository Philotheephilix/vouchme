"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/session";

/** Four items, not five — five text labels clipped at 360px. Explore and Reports moved into
 *  Profile (UX reference: Metri/Circles' Home / Wallet / Card / Shop shape). */
export function BottomNav() {
  const pathname = usePathname();
  const { address } = useAuth();

  const items: Array<{ href: string; label: string; testid: string; active: boolean }> = [
    { href: "/", label: "Home", testid: "nav-home", active: pathname === "/" },
    { href: "/search", label: "Search", testid: "nav-search", active: pathname.startsWith("/search") },
    { href: "/vouch", label: "Vouches", testid: "nav-vouch", active: pathname.startsWith("/vouch") },
    {
      href: address ? `/profile/${address}` : "/enroll",
      label: "Profile",
      testid: "nav-profile",
      active: pathname.startsWith("/profile") || pathname.startsWith("/agents"),
    },
  ];

  return (
    <nav
      data-testid="bottom-nav"
      className="fixed inset-x-0 bottom-0 z-50 flex border-t border-rule bg-void"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {items.map((item) => (
        <Link
          key={item.testid}
          href={item.href}
          data-testid={item.testid}
          className="flex flex-1 flex-col items-center justify-center gap-1"
          style={{
            height: 56,
            minWidth: 44,
            borderTop: item.active ? "2px solid var(--color-seal)" : "2px solid transparent",
          }}
        >
          <span
            className="font-mono text-2xs uppercase tracking-widest"
            style={{ color: item.active ? "var(--color-cream)" : "var(--color-graphite)" }}
          >
            {item.label}
          </span>
        </Link>
      ))}
    </nav>
  );
}
