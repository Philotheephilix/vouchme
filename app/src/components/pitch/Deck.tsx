"use client";

/**
 * app/src/components/pitch/Deck.tsx
 *
 * The chrome around the slides: a snapping scroll container, a keyboard model, and a fixed rail
 * that says where you are and lets you jump.
 *
 * Design decisions worth defending:
 *
 * - **The slides are children, not data.** They arrive already rendered from the server, so the
 *   full text of every slide is in the initial HTML. This component only moves the viewport; it
 *   never decides what a slide says, and it never unmounts one. That also means Cmd-F, print,
 *   and any reader that ignores JavaScript still get the whole deck.
 *
 * - **Snap by `proximity`, not `mandatory`.** Mandatory snapping fights any slide that is taller
 *   than the viewport — which, on a 360px phone, several of these are. Proximity snaps when you
 *   let go near a boundary and otherwise gets out of the way, so a dense slide can simply be
 *   scrolled. Explicit navigation (keys, buttons, the rail) always lands exactly on a boundary,
 *   so nothing is lost by not forcing it.
 *
 * - **`prefers-reduced-motion` is honoured at the source.** globals.css already flattens CSS
 *   animation and transition durations, but `scrollTo({ behavior: "smooth" })` is a script-driven
 *   animation that no stylesheet can reach. It is checked here and downgraded to an instant jump.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface DeckEntry {
  /** DOM id of the corresponding <section>, also the deep-link fragment */
  id: string;
  /** short label for the jump rail's accessible name */
  nav: string;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function Deck({ index, children }: { index: DeckEntry[]; children: ReactNode }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [current, setCurrent] = useState(0);
  // Keyboard handlers are bound once; without a mirror they would close over the first render's
  // `current` and every arrow press would navigate from slide 0.
  const currentRef = useRef(0);
  currentRef.current = current;

  const goTo = useCallback(
    (i: number) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const clamped = Math.max(0, Math.min(index.length - 1, i));
      const entry = index[clamped];
      if (!entry) return;
      const target = scroller.querySelector<HTMLElement>(`[data-slide="${clamped}"]`);
      if (!target) return;
      // `offsetTop` is measured against the scroller because the scroller is positioned — see the
      // `relative` class below. Without that, this would measure against the document and scroll
      // to the wrong place on every slide but the first.
      scroller.scrollTo({ top: target.offsetTop, behavior: prefersReducedMotion() ? "auto" : "smooth" });
      setCurrent(clamped);
      if (typeof history !== "undefined") {
        // Deep-linkable without adding a history entry per slide — Back should leave the deck,
        // not walk it backwards one slide at a time.
        history.replaceState(null, "", `#${entry.id}`);
      }
    },
    [index],
  );

  // Track the slide occupying the middle band of the viewport. A threshold-based observer cannot
  // do this: a slide taller than the viewport never reaches any threshold above ~0.9, so it would
  // never be reported as current. Collapsing the root to a horizontal band through the middle
  // makes "which slide is the reader looking at" a question with exactly one answer at all times.
  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const sections = Array.from(scroller.querySelectorAll<HTMLElement>("[data-slide]"));
    if (sections.length === 0) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const n = Number(entry.target.getAttribute("data-slide"));
          if (Number.isFinite(n)) setCurrent(n);
        }
      },
      { root: scroller, rootMargin: "-49% 0px -49% 0px", threshold: 0 },
    );
    for (const section of sections) observer.observe(section);
    return () => observer.disconnect();
  }, []);

  // Honour a fragment on load. The browser's native anchor jump is unreliable inside a scroll
  // container that has not finished laying out, so do it explicitly once mounted.
  useEffect(() => {
    const hash = window.location.hash.slice(1);
    if (!hash) return;
    const i = index.findIndex((entry) => entry.id === hash);
    if (i > 0) {
      const scroller = scrollerRef.current;
      const target = scroller?.querySelector<HTMLElement>(`[data-slide="${i}"]`);
      if (scroller && target) {
        scroller.scrollTo({ top: target.offsetTop, behavior: "auto" });
        setCurrent(i);
      }
    }
    // Intentionally mount-only: re-running this on every `index` identity change would yank a
    // reader back to the fragment mid-deck.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // Never steal a key from something the user is typing into. There is no such control in the
      // deck today, and this costs nothing if one is ever added.
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;

      switch (event.key) {
        case "ArrowRight":
        case "ArrowDown":
        case "PageDown":
        case " ":
          event.preventDefault();
          goTo(currentRef.current + 1);
          break;
        case "ArrowLeft":
        case "ArrowUp":
        case "PageUp":
          event.preventDefault();
          goTo(currentRef.current - 1);
          break;
        case "Home":
          event.preventDefault();
          goTo(0);
          break;
        case "End":
          event.preventDefault();
          goTo(index.length - 1);
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, index.length]);

  const atStart = current === 0;
  const atEnd = current === index.length - 1;

  return (
    <div>
      <div
        ref={scrollerRef}
        // `relative` is load-bearing: it makes the scroller the offset parent that `goTo` measures
        // against. `tabIndex` gives the container a focus target so the arrow keys work after a
        // click anywhere in the deck, and so the deck is reachable by keyboard alone.
        className="relative h-[100svh] snap-y snap-proximity overflow-y-auto overscroll-y-contain"
        tabIndex={-1}
        aria-roledescription="carousel"
        aria-label="VouchMe pitch deck"
      >
        {children}
      </div>

      <nav
        aria-label="Slide navigation"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-rule bg-void/90 backdrop-blur-md"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center gap-3 px-4 sm:px-8">
          <span className="shrink-0 font-mono text-2xs font-medium tabular-nums text-graphite" aria-live="polite">
            {String(current + 1).padStart(2, "0")}
            <span className="opacity-50"> / {String(index.length).padStart(2, "0")}</span>
          </span>

          {/* The jump rail. Each tick is a real button with a real accessible name, so the deck is
              navigable by screen reader and by pointer without needing the arrow-key model at all.
              Ticks are hairlines; only the current one takes the accent, which is the one thing on
              this bar worth colouring. */}
          <ol className="flex min-w-0 flex-1 items-center justify-center gap-1">
            {index.map((entry, i) => (
              <li key={entry.id} className="flex min-w-0 flex-1 justify-center">
                <button
                  type="button"
                  onClick={() => goTo(i)}
                  aria-label={`Slide ${i + 1}: ${entry.nav}`}
                  aria-current={i === current ? "true" : undefined}
                  className="flex h-10 w-full items-center justify-center"
                >
                  <span
                    aria-hidden="true"
                    className="block w-full rounded-full transition-colors"
                    style={{
                      backgroundColor: i === current ? "var(--color-accent)" : "var(--color-rule-strong)",
                      height: i === current ? 3 : 2,
                    }}
                  />
                </button>
              </li>
            ))}
          </ol>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => goTo(current - 1)}
              disabled={atStart}
              aria-label="Previous slide"
              className="btn btn-secondary h-10 w-10 px-0 font-mono"
            >
              &#8592;
            </button>
            <button
              type="button"
              onClick={() => goTo(current + 1)}
              disabled={atEnd}
              aria-label="Next slide"
              className="btn btn-secondary h-10 w-10 px-0 font-mono"
            >
              &#8594;
            </button>
          </div>
        </div>
      </nav>
    </div>
  );
}
