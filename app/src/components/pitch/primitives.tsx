/**
 * app/src/components/pitch/primitives.tsx
 *
 * The typographic kit the pitch deck is built from. Server-safe on purpose — no hooks, no state —
 * so every word of every slide is present in the server-rendered HTML rather than arriving after
 * hydration. A deck that only exists once JavaScript runs is a deck that cannot be read by a
 * scraper, by a screen reader in a degraded state, or by anyone on a bad conference network.
 *
 * Everything here is built from the design system in src/app/globals.css and adds no tokens of its
 * own: the `.card` surface (white, borderless, generously rounded, one soft shadow), the `.eyebrow`
 * label, the `.btn` and `.badge` families, the accent-washed `.card-accent`, Montserrat display
 * headings over Karla body text, and IBM Plex Mono for every figure. Colour earns its place —
 * `seal` for positive, `protest` for negative outcomes only, `anchor` for Orb anchors only, and the
 * royal-blue `accent` for the one thing on a slide worth colouring.
 */

import type { ReactNode } from "react";

export type Ink = "cream" | "graphite" | "accent" | "seal" | "protest" | "anchor";

const INK: Record<Ink, string> = {
  cream: "var(--color-cream)",
  graphite: "var(--color-graphite)",
  accent: "var(--color-accent)",
  seal: "var(--color-seal)",
  protest: "var(--color-protest)",
  anchor: "var(--color-anchor)",
};

/** Tinted card washes, built the same way `.card-accent` is: a soft diagonal from the subtle tint
 *  into plain paper, so a coloured surface still reads as the same object as a white one. */
const WASH: Record<"accent" | "seal" | "protest", string> = {
  accent: "linear-gradient(160deg, var(--color-accent-subtle), var(--color-paper) 78%)",
  seal: "linear-gradient(160deg, var(--color-seal-subtle), var(--color-paper) 82%)",
  protest: "linear-gradient(160deg, var(--color-protest-subtle), var(--color-paper) 82%)",
};

/**
 * One slide.
 *
 * `min-h-[100svh]` rather than `h-`: a slide is allowed to be taller than the viewport on a narrow
 * phone and simply scroll, which is the whole reason the scroll container snaps by *proximity*
 * rather than mandatorily (see Deck.tsx). Content is vertically centred when it fits and flows
 * normally when it does not — no slide ever clips.
 *
 * The slide itself paints no background, so the body's paper texture and the app-wide grain veil
 * carry straight through the deck. Only cards are opaque.
 */
export function Slide({
  id,
  n,
  total,
  eyebrow,
  children,
}: {
  id: string;
  n: number;
  total: number;
  eyebrow: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      data-slide={n - 1}
      aria-roledescription="slide"
      aria-label={`Slide ${n} of ${total}: ${eyebrow}`}
      className="flex min-h-[100svh] w-full snap-start flex-col justify-center px-5 pb-24 pt-12 sm:px-10 lg:px-16"
    >
      <div className="mx-auto w-full max-w-5xl">
        <div className="mb-6 flex items-baseline justify-between gap-4 border-b border-rule pb-2.5">
          <span className="eyebrow">{eyebrow}</span>
          <span className="shrink-0 font-mono text-2xs text-graphite">
            {String(n).padStart(2, "0")} / {String(total).padStart(2, "0")}
          </span>
        </div>
        {children}
      </div>
    </section>
  );
}

/** Display type. `hero` is the title slide only; every other slide uses `lead`, so the deck has one
 *  loudest moment rather than twelve competing ones. Sizes clamp between the type-scale tokens so
 *  the same slide reads on a 360px phone and projected on a laptop. Weight, tracking and family
 *  come from the base `h1, h2, h3` rule in globals.css — Montserrat, 700, -0.025em. */
export function Headline({
  children,
  variant = "lead",
  as: Tag = "h2",
}: {
  children: ReactNode;
  variant?: "hero" | "lead";
  as?: "h1" | "h2";
}) {
  const fontSize = variant === "hero" ? "clamp(32px, 5.6vw, 56px)" : "clamp(23px, 3.2vw, 38px)";
  return (
    <Tag className="text-balance" style={{ fontSize, lineHeight: 1.1 }}>
      {children}
    </Tag>
  );
}

export function Lede({ children }: { children: ReactNode }) {
  return (
    <p className="mt-4 max-w-3xl leading-relaxed text-graphite" style={{ fontSize: "clamp(14px, 1.3vw, 18px)" }}>
      {children}
    </p>
  );
}

/** A ruled list. The hairline dividers are the same `border-rule` separation `StatLine` uses for
 *  ledger rows — a deck bullet and a vouch row are deliberately the same object. */
export function Points({ children, tight = false }: { children: ReactNode; tight?: boolean }) {
  return <ul className={`${tight ? "mt-2" : "mt-6"} border-b border-rule`}>{children}</ul>;
}

export function Point({ label, ink = "graphite", children }: { label?: string; ink?: Ink; children: ReactNode }) {
  return (
    <li className="border-t border-rule py-2.5">
      {label ? (
        <div className="eyebrow" style={{ color: INK[ink] }}>
          {label}
        </div>
      ) : null}
      <p className={`text-sm leading-relaxed text-cream ${label ? "mt-1.5" : ""}`}>{children}</p>
    </li>
  );
}

/** The one loud sentence on a slide: a washed card, display type, no border. */
export function Callout({ children, tone = "accent" }: { children: ReactNode; tone?: "accent" | "seal" | "protest" }) {
  return (
    <div className="card mt-6 px-5 py-5 sm:px-7 sm:py-6" style={{ background: WASH[tone] }}>
      <p
        className="font-display font-semibold text-cream"
        style={{ fontSize: "clamp(18px, 2.2vw, 27px)", lineHeight: 1.24, letterSpacing: "-0.02em" }}
      >
        {children}
      </p>
    </div>
  );
}

/** A quiet note under a heavier block — the caveat, the provenance, the thing that keeps a claim
 *  honest. Deliberately small, never omitted. */
export function Aside({ children }: { children: ReactNode }) {
  return <p className="mt-4 max-w-3xl text-2xs leading-relaxed text-graphite">{children}</p>;
}

export function Cols({ children }: { children: ReactNode }) {
  return <div className="mt-6 grid gap-x-10 gap-y-6 md:grid-cols-2">{children}</div>;
}

export function Panel({ title, ink = "graphite", children }: { title: string; ink?: Ink; children: ReactNode }) {
  return (
    <div>
      <h3 className="eyebrow border-b border-rule pb-2.5" style={{ color: INK[ink] }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

export function CodeBlock({ children }: { children: string }) {
  return (
    <pre
      className="scroll-x mt-6 bg-paper-2 p-4 font-mono text-xs leading-relaxed text-cream"
      style={{ borderRadius: "var(--radius-lg)" }}
    >
      {children}
    </pre>
  );
}

/**
 * A figure table on a card surface. Wide content scrolls inside its own box (`.scroll-x`) so the
 * page itself never scrolls sideways — the same rule the rest of the app follows.
 *
 * `numeric` marks the columns that hold figures; those are set in Plex Mono, which is the only way
 * a column of scores reads as a column rather than as ragged text.
 */
export function DataTable({
  head,
  rows,
  numeric = [],
  rowInk = [],
}: {
  head: string[];
  rows: ReactNode[][];
  /** zero-based column indices to render as mono figures */
  numeric?: number[];
  /** optional per-row accent, applied to the first cell */
  rowInk?: (Ink | undefined)[];
}) {
  return (
    <div className="card scroll-x mt-6 overflow-hidden">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th
                key={h}
                scope="col"
                className={`eyebrow whitespace-nowrap border-b border-rule px-4 py-3 align-bottom ${
                  numeric.includes(i) ? "text-right" : ""
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            // eslint-disable-next-line react/no-array-index-key -- rows are a fixed literal; order is the identity
            <tr key={r} className={r % 2 === 1 ? "bg-paper-2/60" : undefined}>
              {row.map((cell, c) => (
                <td
                  key={c}
                  className={`border-b border-rule px-4 py-3 align-top text-xs leading-relaxed text-cream last:border-b-0 ${
                    numeric.includes(c) ? "whitespace-nowrap text-right font-mono font-medium" : ""
                  }`}
                  style={c === 0 && rowInk[r] ? { color: INK[rowInk[r]!], fontWeight: 600 } : undefined}
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A single figure with its label — used sparingly, where one number carries a whole idea. */
export function Figure({ value, label, ink = "cream" }: { value: string; label: string; ink?: Ink }) {
  return (
    <div className="border-t border-rule pt-3">
      <div
        className="font-mono font-medium leading-none"
        style={{ color: INK[ink], fontSize: "clamp(24px, 2.9vw, 38px)" }}
      >
        {value}
      </div>
      <div className="eyebrow mt-2">{label}</div>
    </div>
  );
}

export function FigureRow({ children }: { children: ReactNode }) {
  return <div className="mt-7 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">{children}</div>;
}
