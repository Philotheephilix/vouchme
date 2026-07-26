/**
 * app/src/components/pitch/slides.tsx
 *
 * The deck. Nine slides, written to be read in plain language by someone who has never heard of
 * this project — short sentences, no house jargon, one idea per slide.
 *
 * Every figure traces to a source in this repository:
 *   docs/00-prd.md            — the two rules, the constants, the non-goals
 *   example/README.md         — the SDK surface and the Fiar deposit table
 *   submission/SUBMISSION.txt — package inventory, test counts, and the honest limits
 *
 * No metrics, no market sizes, no projections, because there are none to report.
 */

import type { ReactNode } from "react";
import type { DeckEntry } from "./Deck";
import { RingDiagram } from "./RingDiagram";
import {
  Aside,
  Callout,
  CodeBlock,
  Cols,
  DataTable,
  Figure,
  FigureRow,
  Headline,
  Lede,
  Panel,
  Point,
  Points,
  Slide,
} from "./primitives";

/** Serialisable slide manifest, handed to the (client) Deck for its jump rail and deep links.
 *  Kept beside the slides so a slide can never be added without also appearing in navigation. */
export const SLIDE_INDEX: DeckEntry[] = [
  { id: "title", nav: "Being human is the floor" },
  { id: "problem", nav: "The gap" },
  { id: "thesis", nav: "How trust moves" },
  { id: "names", nav: "A vouch is a name" },
  { id: "constants", nav: "The numbers" },
  { id: "sdk", nav: "How an app uses it" },
  { id: "fiar", nav: "A real example" },
  { id: "shipped", nav: "What is live" },
  { id: "ask", nav: "The ask" },
];

const TOTAL = SLIDE_INDEX.length;

function at(id: string): { id: string; n: number; total: number } {
  const n = SLIDE_INDEX.findIndex((entry) => entry.id === id) + 1;
  return { id, n, total: TOTAL };
}

const NAME_ANATOMY = `carol.alice.vouchme.eth
└─┬─┘ └─┬─┘ └────┬────┘
  │     │        └─ the root name
  │     └───────── alice vouched …
  └─────────────── … for carol`;

const SDK_USAGE = `const standing = await vouchme.standing(address)

if (standing) price(standing.score, standing.tier)`;

export function PitchSlides(): ReactNode {
  return (
    <>
      {/* ── 01 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("title")} eyebrow="VouchMe · World Chain 480">
        <Headline as="h1" variant="hero">
          Proof of human is a floor. VouchMe is the ladder.
        </Headline>
        <Lede>
          People vouch for people. Your score comes from who vouched for you, and how trusted they
          are. Earn it once, and any app can price it in.
        </Lede>
        <FigureRow>
          <Figure value="20" label="Everyone starts here" />
          <Figure value="55" label="Tier 1" ink="seal" />
          <Figure value="140" label="Tier 2" ink="seal" />
          <Figure value="100" label="Orb-verified" ink="anchor" />
        </FigureRow>
      </Slide>

      {/* ── 02 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("problem")} eyebrow="01 · the gap">
        <Headline>Knowing someone is real does not tell you they can be trusted.</Headline>
        <Points>
          <Point label="What we have today">
            World ID proves a live human is here, and gives them one account. That part works, and
            every app should start there.
          </Point>
          <Point label="What is missing" ink="protest">
            Nothing tells you whether to trust that human. So apps guess — follower counts, wallet
            age, a &ldquo;verified&rdquo; badge — or they ask everyone for a deposit.
          </Point>
        </Points>
        <Callout tone="protest">
          &ldquo;Are you real?&rdquo; is answered. &ldquo;Should I trust you?&rdquo; is not.
        </Callout>
      </Slide>

      {/* ── 03 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("thesis")} eyebrow="02 · how trust moves">
        <Headline>Trust has to come from someone who already has it.</Headline>
        <Cols>
          <Panel title="It shrinks as it travels" ink="seal">
            <Points tight>
              <Point>
                A vouch is worth a quarter of the voucher&rsquo;s score, and never more than 20
                points.
              </Point>
              <Point>
                You cannot invent trust. You can only pass on a slice of someone else&rsquo;s, and
                the slice gets smaller each step.
              </Point>
            </Points>
          </Panel>
          <Panel title="It only flows one way" ink="seal">
            <Points tight>
              <Point>
                Scores are worked out starting from Orb-verified people and moving outward. Never
                sideways, never backwards.
              </Point>
              <Point>
                So a group that only vouches for each other gets nothing from itself. They all stay
                at 20 forever.
              </Point>
            </Points>
          </Panel>
        </Cols>
        <Callout>
          That second rule is the whole anti-fraud design. There is no fraud detector to fool —
          cliques simply do not add up.
        </Callout>
        <RingDiagram />
      </Slide>

      {/* ── 04 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("names")} eyebrow="03 · where a vouch lives">
        <Headline>A vouch is not stored in our database. It is an ENS name.</Headline>
        <CodeBlock>{NAME_ANATOMY}</CodeBlock>
        <Points>
          <Point>
            Delete the name and the vouch is gone. There is no second copy anywhere to disagree with
            it.
          </Point>
          <Point>
            The name expires in 90 days unless renewed, so vouches go stale on their own. Taking one
            back deletes the name.
          </Point>
          <Point label="Why it matters" ink="seal">
            Anyone can read the whole trust graph with normal ENS tools, and check any score
            themselves. We are not the only source.
          </Point>
        </Points>
      </Slide>

      {/* ── 05 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("constants")} eyebrow="04 · the numbers">
        <Headline>Nothing builds up over time. A score is just today&rsquo;s graph.</Headline>
        <DataTable
          head={["What", "Value", "Why"]}
          numeric={[1]}
          rows={[
            ["Starting score", "20", "Where a verified human begins. Nothing can push them below it."],
            ["Tier 1", "55", "You can now vouch for others — three at a time."],
            ["Tier 2", "140", "Ten at a time, and your vouches carry further."],
            ["Orb-verified", "100", "Fixed. These people are the starting point, not players."],
            ["A vouch is worth", "25%", "Of the voucher's own score. Strong voucher, stronger vouch."],
            ["Most one vouch can give", "20", "One friend can never carry a person on their own."],
            ["A vouch lasts", "90 days", "Then it stops counting unless renewed."],
            ["Taking it back", "free", "Instant, one tap, no cost, no permission needed."],
          ]}
        />
      </Slide>

      {/* ── 06 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("sdk")} eyebrow="05 · how an app uses it">
        <Headline>One address in, a score out. That is the whole integration.</Headline>
        <CodeBlock>{SDK_USAGE}</CodeBlock>
        <DataTable
          head={["Ask", "Get back"]}
          rows={[
            ["standing(address)", "Their score and tier. Empty if they never signed up."],
            ["gate(address, policy)", "Do they pass — and if not, why not."],
            ["proximity(a, b)", "Are these two connected, and who vouches for both."],
          ]}
        />
        <Points>
          <Point>
            A World App mini app already knows the user&rsquo;s address. No API key, no sign-up, no
            permission screen. Reading a score is one web request.
          </Point>
          <Point label="One thing is missing on purpose" ink="protest">
            There is no way to vouch through the API, and there never will be. Vouching needs a real
            person in the app. Our 18 agent tools cannot vouch for anyone.
          </Point>
        </Points>
      </Slide>

      {/* ── 07 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("fiar")} eyebrow="06 · a real example · fiar.davinciin.xyz">
        <Headline>Nobody is turned away. Everybody is priced.</Headline>
        <Lede>
          Fiar lets you borrow a drill from a neighbour. Your standing sets the deposit. It is built
          on the three calls on the last slide, and it moves real money on World Chain.
        </Lede>
        <DataTable
          head={["Who", "Score", "Deposit on a 0.03 WLD drill", "Can borrow"]}
          numeric={[1, 2, 3]}
          rowInk={["protest", undefined, "seal", "anchor"]}
          rows={[
            ["Six accounts vouching for each other", "20.0", "0.0300 — full price", "2 / 6"],
            ["carol", "50.0", "0.0214", "2 / 6"],
            ["alice", "60.0", "0.0195", "5 / 6"],
            ["anchor1 · Orb-verified", "100.0", "0.0045", "6 / 6"],
          ]}
        />
        <Callout tone="protest">
          The fake ring is not blocked. It just gets no discount — and Fiar never had to know what a
          fake ring is.
        </Callout>
        <Aside>
          Fiar also takes another 10% off when someone vouches for both people. On screen that is a
          sentence: &ldquo;anchor1 and anchor2 vouch for you both.&rdquo; No personhood check can
          answer that, because one person alone has no neighbours.
        </Aside>
      </Slide>

      {/* ── 08 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("shipped")} eyebrow="07 · what is live, and what is not">
        <Headline>Six parts, all built and deployed — and an honest list of what is not.</Headline>
        <Cols>
          <Panel title="Built" ink="seal">
            <Points tight>
              <Point label="contracts">Six of them, live on World Chain. 58 tests.</Point>
              <Point label="engine">
                The scoring code. Same input, same answer, everywhere. 60 tests, no dependencies.
              </Point>
              <Point label="indexing">
                One package reads two protocols across five chains, with no per-protocol code.
              </Point>
              <Point label="gateway">Turns a score into an ENS record, worked out fresh each time.</Point>
              <Point label="agents">18 read-only tools, running the same scoring code.</Point>
              <Point label="app">The World App mini app, plus a working outside integration.</Point>
            </Points>
          </Panel>
          <Panel title="Not yet true" ink="protest">
            <Points tight>
              <Point>No users, no revenue. Everything on the left is code and deployments.</Point>
              <Point>
                Both people who signed up are Orb-verified, whose score is fixed — so our one real
                vouch changed nothing. The maths is shown on a test network instead.
              </Point>
              <Point>
                A liveness check we wanted is not enforced. The wallet cannot issue it today.
              </Point>
              <Point>One key controls all the names. That has to be shared out before launch.</Point>
            </Points>
          </Panel>
        </Cols>
      </Slide>

      {/* ── 09 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("ask")} eyebrow="08 · the ask">
        <Headline>
          One person&rsquo;s standing, earned once, useful in every app that wants it.
        </Headline>
        <Cols>
          <Panel title="What this makes easy next">
            <Points tight>
              <Point label="Lost your phone">
                The people who vouched for you can get you back in. No seed phrase, no support desk.
              </Point>
              <Point label="Private proof">
                Prove you are Tier 1 without saying who you are.
              </Point>
              <Point label="Vouching in person">
                Two phones tap. One verified person can start ten others in ten minutes.
              </Point>
            </Points>
          </Panel>
          <Panel title="What we want" ink="seal">
            <Points tight>
              <Point label="1 · use it" ink="seal">
                One call on an address you already have. What a score is worth stays your decision.
              </Point>
              <Point label="2 · run a second copy" ink="seal">
                &ldquo;Anyone can check it&rdquo; only means something once someone else does.
              </Point>
              <Point label="3 · use our schema" ink="seal">
                Trust has no shared data standard. We wrote one and shipped working code for it.
              </Point>
            </Points>
          </Panel>
        </Cols>
        <Callout>
          Being human is the floor. Everything above it should be earned from people who already
          stand on it.
        </Callout>
      </Slide>
    </>
  );
}
