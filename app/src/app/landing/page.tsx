import type { CSSProperties } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";
import { DepthPath, DepthRing } from "./diagrams";
import styles from "./landing.module.css";

/**
 * /landing — the public marketing page.
 *
 * Public by allowlist in `AppGate` (`PUBLIC_ROUTES`), so it renders with no session, no wallet and
 * no bottom nav. Entirely server-rendered: no client components, no canvas, no WebGL, no runtime
 * dependency beyond what the app already ships. Motion is CSS-only and progressive.
 *
 * Every figure on this page is a protocol constant from `docs/00-prd.md` or a measured number from
 * the Fiar worked example in `example/README.md`. There is no traction to report and none is
 * implied: the closing section states plainly what does not exist yet.
 */

export const metadata: Metadata = {
  title: "VouchMe — proof of human is a floor",
  description:
    "World ID proves you are a human. It cannot prove you are not already here under another name. VouchMe scores you from the people who already know you, and makes collusion worth nothing.",
};

const NAV = [
  { href: "#gap", label: "The gap" },
  { href: "#attenuation", label: "Attenuation" },
  { href: "#depth", label: "The depth rule" },
  { href: "#fiar", label: "Worked example" },
  { href: "#integrate", label: "Integrate" },
];

/** The scale, top to bottom. `bottom` is the mark's position on a 0–150 rail. */
const RAIL = [
  { at: 93.3, num: "140", title: "Tier 2", note: "Ten vouch slots. Every vouch worth the maximum.", tone: "var(--color-tier-2)" },
  {
    at: 66.7,
    num: "100",
    title: "Orb anchor",
    note: "Fixed. Depth 0. Ignores every inbound vouch, so it never climbs.",
    tone: "var(--color-tier-2)",
  },
  { at: 36.7, num: "55", title: "Tier 1", note: "Three vouch slots. You can now raise someone else.", tone: "var(--color-tier-1)" },
  {
    at: 13.3,
    num: "20",
    title: "Enrolment floor",
    note: "Where proof of human leaves you. Nobody starts anywhere else.",
    tone: "var(--color-tier-0)",
  },
];

/** 25% of the voucher's score, capped at 20. Bars are scaled against that cap. */
const CASCADE = [
  { name: "anchor1", score: "100", worth: "20.0", capped: true, tone: "var(--color-tier-2)" },
  { name: "alice", score: "60", worth: "15.0", capped: false, tone: "var(--color-tier-1)" },
  { name: "new Tier 1", score: "55", worth: "13.75", capped: false, tone: "var(--color-tier-1)" },
];

/** The SDK snippet from `example/README.md`, as tokens rather than a template literal — a literal's
 *  leading whitespace is exactly what a formatter reflows, and it silently flattened the indentation
 *  once already. `str` is a string literal, `dim` a comment; everything else takes the base ink. */
type Tok = { t: string; tone?: "str" | "dim" };
const SNIPPET: Tok[][] = [
  [{ t: "import { createVouchMe } from " }, { t: '"@vouchme/minikit-sdk"', tone: "str" }],
  [{ t: "" }],
  [{ t: "const vouchme = createVouchMe({ baseUrl: " }, { t: '"https://vouchme.example"', tone: "str" }, { t: " })" }],
  [{ t: "" }],
  [
    { t: "const standing = await vouchme.standing(address)   " },
    { t: "// null if they have no VouchMe account", tone: "dim" },
  ],
  [{ t: "if (standing) {" }],
  [{ t: "  console.log(standing.score, standing.tier, standing.meta.computedAtBlock)" }],
  [{ t: "}" }],
];

/** Measured from the Fiar demo on a 0.03 WLD drill. See example/README.md. */
const FIAR = [
  {
    holder: "ring1.eth",
    score: "20.0",
    deposit: "0.0300",
    reaches: "2 of 6",
    why: "A ring vouching for itself. Every edge is worth zero, so it pays what a stranger pays.",
  },
  {
    holder: "carol",
    score: "50.0",
    deposit: "0.0214",
    reaches: "2 of 6",
    why: "Still Tier 0, but 30 points up — and the owner vouches for her, which is 10% more off.",
  },
  {
    holder: "alice",
    score: "60.0",
    deposit: "0.0195",
    reaches: "5 of 6",
    why: "Tier 1, and both anchors vouch for her and for the owner.",
  },
  {
    holder: "anchor1",
    score: "100.0",
    deposit: "0.0045",
    reaches: "6 of 6",
    why: "Orb anchor. Hits the 15% floor, and still pays.",
  },
];

export default function LandingPage() {
  return (
    <div className={styles.page}>
      <a href="#main" className={styles.skip}>
        Skip to content
      </a>

      <header className={styles.nav}>
        <nav className={`${styles.shell} ${styles.navBar}`} aria-label="Page sections">
          <Link href="/" className={styles.navHome} aria-label="VouchMe, open the app">
            <Wordmark size={19} />
          </Link>
          <ul className={styles.navLinks}>
            {NAV.map((n) => (
              <li key={n.href}>
                <a href={n.href} className={styles.navLink}>
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
          <Link href="/" className="btn btn-primary btn-pill">
            Open the app
          </Link>
        </nav>
      </header>

      <main id="main">
        {/* ── hero ────────────────────────────────────────────────────────────────────────────── */}
        <section className={`${styles.shell} ${styles.hero}`}>
          <div className={styles.heroGrid}>
            <div className={styles.enter}>
              <span className={styles.heroBadge} style={{ "--i": 0 } as CSSProperties}>
                World ID · World Chain · MIT
              </span>
              <h1 className={styles.h1} style={{ "--i": 1 } as CSSProperties}>
                Proof of human is a floor.
                <br />
                <em>VouchMe is the ladder.</em>
              </h1>
              <p className={styles.heroLead} style={{ "--i": 2 } as CSSProperties}>
                World ID proves you are <i>a</i> human. It cannot prove you are not{" "}
                <i>already here under another name.</i> VouchMe closes that gap with the one thing nobody can fake at
                scale: the people who already know you.
              </p>
              <div className={styles.ctaRow} style={{ "--i": 3 } as CSSProperties}>
                <Link href="/" className="btn btn-lg btn-primary">
                  Open the app
                </Link>
                <a href="#depth" className="btn btn-lg btn-secondary">
                  How collusion becomes worthless
                </a>
              </div>
              <p className={styles.heroFoot} style={{ "--i": 4 } as CSSProperties}>
                Nothing is stored. Nothing can be bought. Every number here is a protocol constant or a measured result.
              </p>
            </div>

            <figure className={styles.rail}>
              <div className={styles.railBody}>
                <div className={styles.railTrack} aria-hidden />
                <div className={styles.railFloor} aria-hidden />
                <ul className={styles.railMarks}>
                  {RAIL.map((m) => (
                    <li key={m.num} className={styles.mark} style={{ bottom: `${m.at}%`, color: m.tone, "--tone": m.tone } as CSSProperties}>
                      <span className={styles.markTick} aria-hidden />
                      <span className={styles.markNum}>{m.num}</span>
                      <span className={styles.markText}>
                        <b>{m.title}</b>
                        {m.note}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <figcaption className={styles.railCaption}>
                The whole scale. Nothing falls below 20. A report can take your standing, never your credential.
              </figcaption>
            </figure>
          </div>
        </section>

        {/* ── the gap ─────────────────────────────────────────────────────────────────────────── */}
        <section id="gap" className={`${styles.shell} ${styles.section}`}>
          <hr className={styles.sectionRule} />
          <span className={styles.eyebrow}>The gap</span>
          <h2 className={styles.h2}>A nullifier binds the wrong thing.</h2>
          <p className={styles.lead}>
            The rule is airtight. It just guards the wrong door.
          </p>

          <div className={`${styles.cardGrid} ${styles.cardGrid2} ${styles.figures}`}>
            <article className={`${styles.card} ${styles.cardTinted}`}>
              <span className={styles.cardTag}>Holds perfectly</span>
              <h3 className={styles.cardTitle}>One account per World ID</h3>
              <p className={styles.cardBody}>
                One person, one nullifier, per app. Nothing gets past it. Start here — just do not stop here.
              </p>
            </article>
            <article className={styles.card}>
              <span className={styles.cardTag}>Does not hold</span>
              <h3 className={styles.cardTitle}>One World ID per human</h3>
              <p className={styles.cardBody}>
                Selfie Check is weak. World&apos;s own docs call it{" "}
                <i>&ldquo;weaker than higher-assurance methods like iris scanning.&rdquo;</i> Hold{" "}
                <code>n</code> Selfie Checks and you hold <code>n</code> World IDs — so <code>n</code> accounts.
              </p>
            </article>
          </div>

          <ul className={styles.rejects}>
            <li className={styles.reject}>
              <span className={styles.rejectKey}>close it with hardware</span>
              <span className={styles.rejectVal}>
                Works. Will not reach the people who show up on day one.
              </span>
            </li>
            <li className={styles.reject}>
              <span className={styles.rejectKey}>close it with documents</span>
              <span className={styles.rejectVal}>Shuts out everyone without papers.</span>
            </li>
            <li className={styles.reject}>
              <span className={styles.rejectKey}>close it with a stake</span>
              <span className={styles.rejectVal}>Makes being human a question of money.</span>
            </li>
          </ul>

          <p className={styles.prose}>
            What is left is everywhere, free, and already yours: <strong>people who know you.</strong>
          </p>
        </section>

        {/* ── rule one ────────────────────────────────────────────────────────────────────────── */}
        <section id="attenuation" className={`${styles.shell} ${styles.section}`}>
          <hr className={styles.sectionRule} />
          <span className={styles.eyebrow}>Rule one — attenuation</span>
          <h2 className={styles.h2}>You can relay trust. You cannot mint it.</h2>
          <p className={styles.lead}>
            A vouch is worth a quarter of the voucher&apos;s score, capped at 20. Trust shrinks every time it moves,
            so vouching can never make more of it.
          </p>

          <div className={`${styles.cascade} ${styles.figures}`}>
            <div className={styles.cascadeHead}>
              <span>Voucher</span>
              <span>Score</span>
              <span>Their vouch, against the 20-point cap</span>
              <span style={{ textAlign: "right" }}>Worth</span>
            </div>
            {CASCADE.map((r) => (
              <div key={r.name} className={styles.cascadeRow}>
                <span className={styles.cascadeName}>{r.name}</span>
                <span className={styles.cascadeScore} style={{ "--tone": r.tone } as CSSProperties}>
                  {r.score}
                </span>
                <span className={styles.cascadeBar}>
                  <span
                    className={styles.cascadeFill}
                    style={{ width: `${(parseFloat(r.worth) / 20) * 100}%` }}
                    aria-hidden
                  />
                </span>
                <span className={styles.cascadeWorth}>
                  {r.worth}
                  {r.capped ? <span className={styles.capNote}>cap</span> : null}
                </span>
              </div>
            ))}
          </div>

          <p className={styles.prose}>
            <strong>Being trusted does not make you a bigger tap.</strong> Two anchor vouches lift a new account from
            20 to 60 — past Tier 1, and no further alone.
          </p>
        </section>

        {/* ── rule two: the signature ─────────────────────────────────────────────────────────── */}
        <section id="depth" className={`${styles.shell} ${styles.section}`}>
          <hr className={styles.sectionRule} />
          <span className={styles.eyebrow}>Rule two — direction</span>
          <h2 className={styles.h2}>The anti-collusion rule and the computation order are the same rule.</h2>
          <p className={styles.lead}>
            A score only counts vouches from accounts <strong>closer to an anchor than you are.</strong> That is not a
            fraud rule. It is the order the sum is added in — and it is the whole defence.
          </p>

          <div className={`${styles.panels} ${styles.figures}`}>
            <figure className={styles.panel}>
              <div className={styles.panelHead}>
                <h3 className={styles.panelTitle}>A path out of the anchors</h3>
                <span className={styles.panelSum} style={{ color: "var(--color-accent)" }}>
                  6 crossings
                </span>
              </div>
              <DepthPath className={styles.panelSvg} />
              <figcaption className={styles.panelCaption}>
                Every vouch crosses a line, so every vouch counts. Trust thins as it travels: 100, then 60, then 50.
              </figcaption>
            </figure>

            <figure className={styles.panel}>
              <div className={styles.panelHead}>
                <h3 className={styles.panelTitle}>A ring that vouches for itself</h3>
                <span className={styles.panelSum} style={{ color: "var(--lp-muted)" }}>
                  0 crossings
                </span>
              </div>
              <DepthRing className={styles.panelSvg} />
              <figcaption className={styles.panelCaption}>
                Six accounts, six real vouches, nothing flagged. Nobody here is closer to an anchor than anybody else,
                so nothing counts. All six stay at 20 forever.
              </figcaption>
            </figure>
          </div>

          <blockquote className={styles.pull}>
            <p className={styles.pullText}>There is no collusion detector to tune, evade, or false-positive.</p>
            <p className={styles.pullNote}>
              No threshold to hide under, no model to fool. More accounts only add more edges worth zero.
            </p>
          </blockquote>
        </section>

        {/* ── state ───────────────────────────────────────────────────────────────────────────── */}
        <section id="state" className={`${styles.shell} ${styles.section}`}>
          <hr className={styles.sectionRule} />
          <span className={styles.eyebrow}>State</span>
          <h2 className={styles.h2}>Nothing here accumulates.</h2>
          <p className={styles.lead}>
            A score is a function of the graph right now — no balance to drift, no history to trade.
          </p>

          <dl className={`${styles.ledger} ${styles.figures}`}>
            <div className={styles.ledgerRow}>
              <dt className={styles.ledgerKey}>90 days</dt>
              <dd className={styles.ledgerVal}>
                A vouch dies unless renewed. It drops to <b>zero</b> the moment it does. No ramp, no grace.
              </dd>
            </div>
            <div className={styles.ledgerRow}>
              <dt className={styles.ledgerKey}>free, instant</dt>
              <dd className={styles.ledgerVal}>
                Revoke your own vouch any time, free, live on the next read. A vouch is something you keep saying, not
                something you said once.
              </dd>
            </div>
            <div className={styles.ledgerRow}>
              <dt className={styles.ledgerKey}>recomputed</dt>
              <dd className={styles.ledgerVal}>
                Scores are computed on read, from public data. Anyone can recompute them — including the ones on this
                page.
              </dd>
            </div>
            <div className={styles.ledgerRow}>
              <dt className={styles.ledgerKey}>0</dt>
              <dd className={styles.ledgerVal}>
                Code paths from a token balance into the score. <b>VOUCHME is a bond, not a score</b> — it makes filing
                a report cost something. CI proves it:{" "}
                <code>1,000,000 VOUCHME bonded with zero vouches still scores 20.</code>
              </dd>
            </div>
          </dl>

          <p className={styles.prose}>
            Not transferable. Not collateral. Not for sale.{" "}
            <strong>The moment reputation is liquid, reputation is bought.</strong>
          </p>
        </section>

        {/* ── worked example ──────────────────────────────────────────────────────────────────── */}
        <section id="fiar" className={`${styles.shell} ${styles.section}`}>
          <hr className={styles.sectionRule} />
          <span className={styles.eyebrow}>Worked example</span>
          <h2 className={styles.h2}>Someone else&apos;s app, pricing the same graph.</h2>
          <p className={styles.lead}>
            Fiar lends things between neighbours, and your standing sets the deposit. A score is a dial, not a door:
            nobody is refused, everybody is priced.
          </p>

          <div className={`${styles.tableWrap} ${styles.figures} scroll-x`}>
            <table className={styles.table}>
              <caption>Deposit on a 0.03 WLD drill, settled in WLD</caption>
              <thead>
                <tr>
                  <th scope="col">Holder</th>
                  <th scope="col">Score</th>
                  <th scope="col">Deposit</th>
                  <th scope="col">Catalogue</th>
                  <th scope="col">Why</th>
                </tr>
              </thead>
              <tbody>
                {FIAR.map((r) => (
                  <tr key={r.holder}>
                    <th scope="row">{r.holder}</th>
                    <td className={styles.num}>{r.score}</td>
                    <td className={styles.numHero}>{r.deposit}</td>
                    <td className={styles.num}>{r.reaches}</td>
                    <td className={styles.why}>{r.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <blockquote className={styles.pull}>
            <p className={styles.pullText}>
              The collusion ring is not blocked. It is simply not cheaper.
            </p>
            <p className={styles.pullNote}>
              No code in Fiar knows what a collusion ring is. It reads one number and multiplies.{" "}
              <a href="https://fiar.davinciin.xyz" className={styles.footerLink} style={{ color: "inherit", textDecoration: "underline" }}>
                fiar.davinciin.xyz
              </a>
            </p>
          </blockquote>
        </section>

        {/* ── integrate ───────────────────────────────────────────────────────────────────────── */}
        <section id="integrate" className={`${styles.shell} ${styles.section}`}>
          <hr className={styles.sectionRule} />
          <span className={styles.eyebrow}>Integration</span>
          <h2 className={styles.h2}>One GET. No key, no OAuth, no consent screen.</h2>
          <p className={styles.lead}>
            A World App mini app already knows your wallet address. That is the only key VouchMe needs.
          </p>

          <div className={styles.figures}>
            <pre className={`${styles.code} scroll-x`}>
              <code>
                {SNIPPET.map((line, i) => (
                  <span key={i}>
                    {line.map((tok, j) =>
                      tok.tone ? (
                        <span key={j} className={tok.tone === "str" ? styles.codeKey : styles.codeDim}>
                          {tok.t}
                        </span>
                      ) : (
                        <span key={j}>{tok.t}</span>
                      ),
                    )}
                    {"\n"}
                  </span>
                ))}
              </code>
            </pre>

            <dl className={styles.methods}>
              <div className={styles.method}>
                <dt className={styles.methodName}>standing(idOrAddress)</dt>
                <dd className={styles.methodDesc}>
                  Score, tier, depth, credential, provenance. Returns null for anyone not enrolled — most of the
                  world, and not an error.
                </dd>
              </div>
              <div className={styles.method}>
                <dt className={styles.methodName}>gate(address, policy)</dt>
                <dd className={styles.methodDesc}>
                  The promotion gates, with reasons when it refuses.
                </dd>
              </div>
              <div className={styles.method}>
                <dt className={styles.methodName}>proximity(from, to)</dt>
                <dd className={styles.methodDesc}>
                  Whether two people are connected, and who vouches for both. No other personhood system can answer
                  this — a nullifier has no neighbours.
                </dd>
              </div>
            </dl>

            <p className={styles.prose}>
              There is no <code>vouch()</code> and never will be. Making trust takes a present human. Outsiders read
              only.
            </p>
          </div>
        </section>

        {/* ── the honest close ────────────────────────────────────────────────────────────────── */}
        <section id="honest" className={`${styles.shell} ${styles.section}`}>
          <hr className={styles.sectionRule} />
          <span className={styles.eyebrow}>Where this actually is</span>
          <h2 className={styles.h2}>What there is, and what there isn&apos;t.</h2>
          <p className={styles.lead}>
            This is where a landing page puts logos and user counts. We have none. Here is what we do have.
          </p>

          <div className={`${styles.ledgerCols} ${styles.figures}`}>
            <article className={styles.card}>
              <h3 className={styles.cardTitle}>There is</h3>
              <ul className={`${styles.tally} ${styles.tallyHas}`}>
                <li>A mechanism, specified to the constant.</li>
                <li>A working app: enrol, vouch, revoke, watch a score move.</li>
                <li>Another app pricing real WLD off it.</li>
                <li>Numbers you can recompute yourself.</li>
                <li>The code, MIT.</li>
              </ul>
            </article>
            <article className={styles.card}>
              <h3 className={styles.cardTitle}>There isn&apos;t</h3>
              <ul className={`${styles.tally} ${styles.tallyHasnt}`}>
                <li>Users.</li>
                <li>Revenue.</li>
                <li>Partners or logos.</li>
                <li>A funding round.</li>
                <li>A testimonial, or any number above that did not come from the protocol.</li>
              </ul>
            </article>
          </div>

          <div className={styles.ctaRow}>
            <Link href="/" className="btn btn-lg btn-accent">
              Open the app
            </Link>
            <Link href="/pitch" className="btn btn-lg btn-secondary">
              Read the deck
            </Link>
          </div>
        </section>
      </main>

      <footer className={`${styles.shell} ${styles.footer}`}>
        <div className={styles.footerGrid}>
          <Link href="/" className={styles.navHome} aria-label="VouchMe, open the app">
            <Wordmark size={19} />
          </Link>
          <ul className={styles.footerLinks}>
            <li>
              <Link href="/" className={styles.footerLink}>
                Open the app
              </Link>
            </li>
            <li>
              <Link href="/pitch" className={styles.footerLink}>
                The deck
              </Link>
            </li>
            <li>
              <a href="https://fiar.davinciin.xyz" className={styles.footerLink}>
                Fiar, the worked example
              </a>
            </li>
          </ul>
        </div>
        <p className={styles.footerNote}>
          Scores are scoped to VouchMe. This is not a universal reputation oracle and is not trying to be. MIT.
        </p>
      </footer>
    </div>
  );
}
