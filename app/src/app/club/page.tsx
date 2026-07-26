import type { Metadata } from "next";
import { Archivo, Archivo_Black } from "next/font/google";
import styles from "./club.module.css";

const archivo = Archivo({
  subsets: ["latin"],
  weight: ["400", "600", "700", "800", "900"],
  variable: "--font-archivo",
  display: "swap",
});

const archivoBlack = Archivo_Black({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-archivo-black",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ATLANTA · Club — House Music",
  description: "Nova edição · 20.06 · MeMachine, Marcelo Kaz, Segalla, André Escobar.",
};

/* Risograph spray-ink bloom: a displaced radial gradient torn at the edges by
   fractal noise, dusted with a multiply grain overlay for that printed texture. */
function InkBloom() {
  return (
    <svg
      className={styles.ink}
      viewBox="0 0 360 640"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <defs>
        <radialGradient id="club-core" cx="49%" cy="53%" r="60%">
          <stop offset="0%" stopColor="#0f27cf" />
          <stop offset="28%" stopColor="#1e3dff" />
          <stop offset="55%" stopColor="#3253ff" />
          <stop offset="78%" stopColor="#5f7bff" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#5f7bff" stopOpacity="0" />
        </radialGradient>
        <filter id="club-warp" x="-25%" y="-25%" width="150%" height="150%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.011 0.015"
            numOctaves="2"
            seed="11"
            result="noise"
          />
          <feDisplacementMap
            in="SourceGraphic"
            in2="noise"
            scale="72"
            xChannelSelector="R"
            yChannelSelector="G"
          />
        </filter>
        <filter id="club-grain">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.85"
            numOctaves="2"
            seed="4"
            stitchTiles="stitch"
            result="g"
          />
          <feColorMatrix
            in="g"
            type="matrix"
            values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.55 0"
          />
        </filter>
      </defs>

      <rect width="360" height="640" fill="#f7f6f3" />

      <g filter="url(#club-warp)">
        <ellipse cx="181" cy="338" rx="146" ry="270" fill="url(#club-core)" />
        <ellipse cx="150" cy="230" rx="84" ry="126" fill="#1e3dff" opacity="0.45" />
        <ellipse cx="210" cy="468" rx="94" ry="128" fill="#2a48ff" opacity="0.4" />
      </g>

      <rect
        width="360"
        height="640"
        filter="url(#club-grain)"
        opacity="0.14"
        style={{ mixBlendMode: "multiply" }}
      />
    </svg>
  );
}

export default function ClubFlyerPage() {
  return (
    <main className={`${styles.stage} ${archivo.variable} ${archivoBlack.variable}`}>
      <div className={styles.poster}>
        <InkBloom />

        <div className={styles.content}>
          <header className={styles.topRow}>
            <span>Nova edição</span>
            <span>
              Made <span className={styles.soft}>with</span> Soul
            </span>
          </header>

          <div className={styles.brandRow}>
            <span className={styles.atlBox}>atl</span>
            <span className={styles.wordmark}>Atlanta.</span>
          </div>

          <h1 className={styles.headline}>Club</h1>

          <div className={styles.dateRow}>
            <span className={styles.date}>20.06</span>
            <span className={styles.timePill}>[19h•05h]</span>
          </div>

          <ul className={styles.lineup}>
            <li className={styles.strong}>MeMachine</li>
            <li>
              Marcelo <b>Kaz</b>
            </li>
            <li className={styles.strong}>Segalla</li>
            <li>
              André <b>Escobar</b>
            </li>
          </ul>

          <span className={styles.vertical}>House Music</span>

          <span className={styles.address}>Quintino Bocaiúva, 1025</span>
        </div>
      </div>
    </main>
  );
}
