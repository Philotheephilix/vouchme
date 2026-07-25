"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS: Array<{ href: string; label: string; testid: string }> = [
  { href: "/", label: "Home", testid: "nav-home" },
  { href: "/vouch", label: "Vouch", testid: "nav-vouch" },
  { href: "/explore", label: "Explore", testid: "nav-explore" },
  { href: "/reports", label: "Reports", testid: "nav-reports" },
  { href: "/agents", label: "Profile", testid: "nav-agents" },
];

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav
      data-testid="bottom-nav"
      className="fixed inset-x-0 bottom-0 z-50 flex border-t border-rule bg-void"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {ITEMS.map((item) => {
        const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            data-testid={item.testid}
            className="flex flex-1 flex-col items-center justify-center gap-1"
            style={{
              height: 56,
              minWidth: 44,
              borderTop: active ? "2px solid var(--color-seal)" : "2px solid transparent",
            }}
          >
            <span
              className="font-mono text-2xs uppercase tracking-widest"
              style={{ color: active ? "var(--color-cream)" : "var(--color-graphite)" }}
            >
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
