"use client";

import type { ReactNode } from "react";
import { HeroUIProvider } from "@heroui/react";
import { MiniKitProvider } from "@worldcoin/minikit-js/minikit-provider";
import { AuthProvider } from "@/lib/session";
import { AppGate } from "@/components/AppGate";

export function Providers({ children }: { children: ReactNode }): ReactNode {
  return (
    <MiniKitProvider props={{ appId: process.env.NEXT_PUBLIC_APP_ID }}>
      <HeroUIProvider>
        <AuthProvider>
          <AppGate>{children}</AppGate>
        </AuthProvider>
      </HeroUIProvider>
    </MiniKitProvider>
  );
}
