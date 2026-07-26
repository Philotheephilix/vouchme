import { truncateMiddle } from "@/lib/format";
import { ConcentricRings } from "./Artifacts";
import { AccountControl } from "./AccountControl";
import { Wordmark } from "./Wordmark";

interface HeaderProps {
  /** small wide-tracked kicker above the title, e.g. "REPORTS". Omit to lead with the title alone. */
  eyebrow?: string;
  /** the big display line — a page name or an ENS identifier */
  title?: string;
  /** one quiet line under the title for context */
  subtitle?: string;
  /** render the title as a mono identifier (ENS names, addresses) rather than display sans */
  mono?: boolean;
}

/**
 * Page chrome + the page's voice. A thin sticky bar keeps the wordmark and account control pinned;
 * below it, a large display title gives every screen a face instead of a whisper. The title scrolls
 * away with the content — only the bar stays.
 */
export function Header({ eyebrow, title, subtitle, mono = false }: HeaderProps) {
  return (
    <>
      <div
        className="sticky top-0 z-30"
        style={{
          // pad the whole bar down past the notch/status bar, then the row keeps its own height
          paddingTop: "calc(env(safe-area-inset-top) + 6px)",
          background: "linear-gradient(180deg, rgba(238,240,244,.94), rgba(238,240,244,.6) 70%, rgba(238,240,244,0))",
          backdropFilter: "blur(12px)",
          WebkitBackdropFilter: "blur(12px)",
        }}
      >
        <div className="flex items-center justify-between gap-3 px-5" style={{ minHeight: 48 }}>
          <Wordmark size={17} />
          <AccountControl />
        </div>
      </div>

      <div className="relative overflow-hidden px-5 pt-1 pb-2">
        {/* faint poster ring bleeding off the top-right — gives the title block depth, not noise.
            Held still: a perpetual spin behind every page header is motion nobody asked for. */}
        <ConcentricRings
          size={188}
          rings={9}
          weight={1.5}
          className="artifact artifact-faint"
          style={{ position: "absolute", top: -78, right: -58, zIndex: 0 }}
        />
        {eyebrow ? <div className="relative z-[1] eyebrow anim-rise-sm">{eyebrow}</div> : null}
        {title ? (
          <h1
            className={`relative z-[1] anim-rise mt-1.5 ${mono ? "truncate-mono" : ""}`}
            style={
              mono
                ? { fontSize: "clamp(22px, 6.5vw, 28px)", fontWeight: 700, letterSpacing: "-.02em", color: "var(--color-cream)" }
                : { fontSize: "clamp(27px, 8.5vw, 36px)", fontWeight: 700, lineHeight: 1.03, letterSpacing: "-.035em", color: "var(--color-cream)" }
            }
          >
            {mono ? truncateMiddle(title, 26) : title}
          </h1>
        ) : null}
        {subtitle ? (
          <p className="relative z-[1] anim-rise-sm mt-1.5 text-sm font-medium text-graphite" style={{ animationDelay: ".05s" }}>
            {subtitle}
          </p>
        ) : null}
      </div>
    </>
  );
}
