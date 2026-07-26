interface WordmarkProps {
  /** font-size in px for the lockup; the mark scales as one unit from here. Default 17. */
  size?: number;
  className?: string;
}

/**
 * The VouchMe wordmark: `vouch` + a green `_` + `me`, set in the mono face so it reads as a
 * terminal-style lockup. The underscore is the ONLY place the brand green (`--color-brand`)
 * appears in the chrome — one scarce accent, exactly as the logo intends. Letters take
 * `currentColor`, so the mark recolours with its surroundings (ink on light, light on dark).
 */
export function Wordmark({ size = 17, className }: WordmarkProps) {
  return (
    <span
      className={className}
      style={{
        fontFamily: "var(--font-mono)",
        fontSize: size,
        fontWeight: 600,
        letterSpacing: "-0.04em",
        lineHeight: 1,
        color: "currentColor",
        whiteSpace: "nowrap",
        userSelect: "none",
      }}
      aria-label="vouch_me"
    >
      vouch<span style={{ color: "var(--color-brand)" }}>_</span>me
    </span>
  );
}
