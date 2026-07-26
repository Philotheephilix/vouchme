import type { Metadata } from "next";
import { Deck } from "@/components/pitch/Deck";
import { PitchSlides, SLIDE_INDEX } from "@/components/pitch/slides";

/**
 * /pitch — the VouchMe pitch deck.
 *
 * A public, presenter-free deck: twelve slides that have to stand on their own when forwarded
 * with no context, read on a phone inside World App, and read again projected on a laptop.
 *
 * The slides are server components (src/components/pitch/slides.tsx), so the complete text of the
 * deck is in the initial HTML — nothing here waits for hydration to say anything. The only client
 * component is the deck chrome (src/components/pitch/Deck.tsx), which moves the viewport and
 * nothing else: keyboard navigation, a jump rail, and deep-linkable fragments.
 *
 * Static by construction. This route reads no chain data, no cookies and no session — there is
 * nothing here to make stale, so nothing here is dynamic.
 */

export const metadata: Metadata = {
  title: "VouchMe — Proof of human is a floor. VouchMe is the ladder.",
  description:
    "Human-to-human trust as the missing primitive for the web3 ecosystem: one person's social standing, earned once, priced into any app that wants it.",
};

export default function PitchPage() {
  return (
    <Deck index={SLIDE_INDEX}>
      <PitchSlides />
    </Deck>
  );
}
