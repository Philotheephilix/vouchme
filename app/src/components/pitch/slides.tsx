/**
 * app/src/components/pitch/slides.tsx
 *
 * The deck itself. Twelve slides, adapted from the Sequoia/YC pitch structure for a project that
 * has architecture and deployments but no users, no revenue and no traction — so the slots the
 * framework reserves for Traction, Market Size, Business Model and Team are spent instead on the
 * things that are actually true and actually load-bearing: the mechanism, the proof that the
 * mechanism survives contact with somebody else's app, and an explicit written list of what is
 * not yet true.
 *
 * Every figure on every slide traces to a source in this repository:
 *   docs/00-prd.md          — the two structural rules, the constants, the non-goals
 *   docs/15-extensions.md   — the "designed, not shipped" column on the last slide
 *   example/README.md       — the SDK surface and the Fiar deposit table
 *   submission/SUBMISSION.txt — package inventory, test counts, and the honest limits
 *
 * Nothing here is invented. There are no metrics, no market sizes and no projections, because
 * there are none to report, and a fabricated number would be the only thing on these slides that
 * a reader could catch us on.
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
  { id: "title", nav: "Proof of human is a floor" },
  { id: "problem", nav: "The gap a nullifier leaves" },
  { id: "thesis", nav: "Two structural rules" },
  { id: "direction", nav: "Why collusion does not pay" },
  { id: "constants", nav: "Every number, and what it is for" },
  { id: "names", nav: "A vouch is a name" },
  { id: "bond", nav: "The token is a bond, not a score" },
  { id: "sdk", nav: "Three methods, one address" },
  { id: "fiar", nav: "Karma is a dial, not a door" },
  { id: "proximity", nav: "The read nobody else can answer" },
  { id: "shipped", nav: "What is live, and what is not" },
  { id: "ask", nav: "The ask" },
];

const TOTAL = SLIDE_INDEX.length;

function at(id: string): { id: string; n: number; total: number } {
  const n = SLIDE_INDEX.findIndex((entry) => entry.id === id) + 1;
  return { id, n, total: TOTAL };
}

const NAME_ANATOMY = `carol.alice.vouchme.eth
└─┬─┘ └─┬─┘ └────┬────┘
  │     │        └─ the registry root
  │     └───────── alice vouched …
  └─────────────── … for carol

vouchme.score   60.0    computed at resolution time,
vouchme.tier    1       from live Subgraph data —
vouchme.depth   1       never written, never stale.`;

const SDK_USAGE = `import { createVouchMe } from "@vouchme/minikit-sdk"

const vouchme = createVouchMe({ baseUrl: "https://vouchme.example" })
const standing = await vouchme.standing(address)   // null if never enrolled

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
          A trust graph where a vouch is a name you own, and your score comes from who vouched for
          you — weighted by how trusted they are. Human-to-human trust as the missing primitive:
          one person&rsquo;s social standing, earned once, priced into any app that wants it.
        </Lede>
        <FigureRow>
          <Figure value="20" label="Base · Selfie Check" />
          <Figure value="55" label="Tier 1" ink="seal" />
          <Figure value="140" label="Tier 2" ink="seal" />
          <Figure value="100" label="Orb anchor · fixed" ink="anchor" />
        </FigureRow>
        <Aside>
          Six packages in one workspace, deployed on World Chain mainnet, resolvable by any ENS
          client as live text records, and already priced into a working integration at
          fiar.davinciin.xyz. No users, no revenue, no traction — this deck reports code and
          deployments, and says so on slide 11.
        </Aside>
      </Slide>

      {/* ── 02 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("problem")} eyebrow="01 · the gap">
        <Headline>A nullifier proves a human is here. It cannot prove they are not already here.</Headline>
        <Points>
          <Point label="World ID nullifier">
            Per app, per action, a person can produce exactly one nullifier. That gives you{" "}
            <strong className="font-semibold">one account per World ID</strong>. The guarantee is
            airtight, and it is where every app should start.
          </Point>
          <Point label="Selfie Check">
            A low-assurance biometric credential — device camera, liveness, facial similarity.
            World&rsquo;s own documentation calls it &ldquo;some Sybil resistance … weaker than
            higher-assurance methods like iris scanning,&rdquo; valid for 90 days.
          </Point>
          <Point label="The gap" ink="protest">
            An attacker who can obtain <em>n</em> Selfie Check credentials obtains <em>n</em>{" "}
            nullifiers, and therefore <em>n</em> accounts. The nullifier constraint is airtight and
            irrelevant, because it binds the wrong thing.
          </Point>
        </Points>
        <Callout tone="protest">
          Proof of personhood answers &ldquo;is this a live human?&rdquo; It does not answer
          &ldquo;is this human the same one who already has an account?&rdquo;
        </Callout>
        <Aside>
          Closing that gap with hardware works, but an Orb does not scale to the population that
          shows up on day one. Closing it with document checks excludes people without documents.
          Closing it with staking makes personhood a function of capital.
        </Aside>
      </Slide>

      {/* ── 03 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("thesis")} eyebrow="02 · the thesis">
        <Headline>
          Close it with the only Sybil-resistant resource already densely distributed among real
          humans: other humans who already know them.
        </Headline>
        <Callout>
          Trust must come from someone who is already trusted, and the amount you can transfer is
          bounded.
        </Callout>
        <Cols>
          <Panel title="Rule 1 · attenuation" ink="seal">
            <Points tight>
              <Point>
                Each vouch is worth <strong className="font-semibold">25% of the voucher&rsquo;s
                own score, capped at 20 points</strong>. Trust decays as it moves away from an
                anchor.
              </Point>
              <Point>
                You cannot mint reputation. You can only relay a fraction of somebody else&rsquo;s,
                and the fraction shrinks with every hop.
              </Point>
            </Points>
          </Panel>
          <Panel title="Rule 2 · direction" ink="seal">
            <Points tight>
              <Point>
                A score takes contributions only from{" "}
                <strong className="font-semibold">strictly lower depth</strong>. Scores are computed
                outward from anchors — never sideways, never backwards.
              </Point>
              <Point>
                A clique that vouches for itself contains no member at lower depth than itself, so
                it contributes exactly zero to itself and stays at the base score forever.
              </Point>
            </Points>
          </Panel>
        </Cols>
        <Aside>
          Two rules do all the work. Everything else in the system — tiers, slots, expiry, reports,
          the token — is bookkeeping around them.
        </Aside>
      </Slide>

      {/* ── 04 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("direction")} eyebrow="03 · why collusion does not pay">
        <Headline>The anti-collusion rule and the computation order are the same rule.</Headline>
        <Lede>
          &ldquo;Sum your vouches&rdquo; is exploitable by arithmetic rather than by bug: with base
          20, multiplier 0.25 and a per-edge cap of 20, a ring of seven accounts all sitting at 140
          satisfies S = 20 + 6 × min(0.25S, 20) exactly — a <em>valid solution</em>,
          indistinguishable from seven real people. Detection cannot fix that.
        </Lede>
        <Callout>
          We do not change the equation — we change which solution is taken: the <em>least</em>{" "}
          fixed point, computed outward from Orb-verified anchors.
        </Callout>
        <RingDiagram />
      </Slide>

      {/* ── 05 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("constants")} eyebrow="04 · every number, and what it is for">
        <Headline>Nothing accumulates. A score is a pure function of the current graph.</Headline>
        <DataTable
          head={["Quantity", "Value", "What it is for"]}
          numeric={[1]}
          rows={[
            [
              "base · Selfie Check enrollment",
              "20",
              "The floor a live human starts on, and the floor no accusation can push them below.",
            ],
            ["Tier 1", "55", "Vouching unlocks, with three slots. Tier 0 accounts cannot vouch at all."],
            ["Tier 2", "140", "Ten slots, and the account can relay depth onward to others."],
            [
              "Orb anchor",
              "100",
              "Fixed, depth 0, and it ignores every inbound vouch. Anchors are the origin, not participants.",
            ],
            ["Vouch weight", "25%", "Of the voucher's own score — a strong voucher is worth more than a weak one."],
            ["Vouch cap", "20", "The most any one relationship can ever be worth. One friend can never carry a person."],
            ["Vouch lifetime", "90 d", "Dies unless re-affirmed. The contribution drops to zero immediately, with no ramp."],
            ["Revocation", "free", "Unilateral, instant, at zero cost, taking effect on the next read."],
          ]}
        />
        <Aside>
          An anchor&rsquo;s fixed 100 sits <em>below</em> the Tier 2 threshold of 140 and can never
          climb. That is deliberate, and it is something every integrator has to special-case:
          scaling a benefit naively across the score range charges the strongest credential in the
          system more than a well-vouched member.
        </Aside>
      </Slide>

      {/* ── 06 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("names")} eyebrow="05 · the edge has no database row">
        <Headline>A vouch is not a record about a name. It is the name.</Headline>
        <CodeBlock>{NAME_ANATOMY}</CodeBlock>
        <Points>
          <Point>
            Delete the name and the edge is gone. There is no second place where the edge also
            lives, so there is no second place for it to disagree.
          </Point>
          <Point>
            Depth in the graph is the label count in the name, so the max-depth rule is a rule about
            how long your name is. Expiry is name expiry. Revoking burns the name.
          </Point>
          <Point>
            A member is a registry <em>contract</em>, not a record — issuing a vouch is{" "}
            <code className="font-mono text-xs">register(label, vouchee)</code> inside your own
            registry. Walking a trust path on chain is the same breadth-first walk the engine does
            off chain.
          </Point>
          <Point label="Why it matters" ink="seal">
            Anyone can resolve the whole graph with stock ENS tooling we did not write, and every
            displayed score is recomputable by a third party from public Subgraph data alone.
          </Point>
        </Points>
      </Slide>

      {/* ── 07 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("bond")} eyebrow="06 · what money is and is not allowed to do">
        <Headline>The token is a bond, not a score.</Headline>
        <Callout tone="seal">1,000,000 VOUCHME bonded, zero vouches, still scores 20. CI asserts it.</Callout>
        <Points>
          <Point label="No path from balance to score">
            The bond exists so that filing a report, rebutting one, and operating a platform each
            cost something. There is no code path from a token balance into the scoring function.
            Money makes claims cost something; it never makes them true.
          </Point>
          <Point label="No liquid reputation">
            Scores are not transferable, not sellable, not collateral, and cannot be purchased. This
            is the sharpest deliberate divergence from Gnosis Circles v2: the moment reputation is
            liquid, reputation is bought.
          </Point>
          <Point label="Humans add, platforms subtract" ink="seal">
            An app gets its own score, granted by the humans who vouch for it and revocable by every
            one of them in one tap. It can query and it can report. It can never vouch for a human —
            enforced by the absence of the function, not by a runtime check.
          </Point>
        </Points>
        <Aside>
          Circles v2 is the prior art we are deliberately echoing. VouchMe differs by being a
          credential rather than a currency, by weighting every edge by the voucher&rsquo;s own
          score — which is what makes cliques worthless — and by anchoring on Orb verification,
          which is what makes the fixed point unique.
        </Aside>
      </Slide>

      {/* ── 08 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("sdk")} eyebrow="07 · the ecosystem surface">
        <Headline>The entire integration is three methods and an address you already have.</Headline>
        <CodeBlock>{SDK_USAGE}</CodeBlock>
        <DataTable
          head={["Method", "Answers"]}
          rows={[
            ["standing(idOrAddress)", "Score, tier, depth, credential status and provenance. null when the person has never enrolled."],
            ["gate(address, policy)", "VouchMe's own promotion gates, with the reasons for a refusal."],
            ["proximity(from, to)", "Are these two people connected, and who vouches for both of them."],
          ]}
        />
        <Points>
          <Point>
            A World App mini app already has the user&rsquo;s wallet address from{" "}
            <code className="font-mono text-xs">MiniKit.walletAuth()</code>, and that address is the
            only join key. No API key, no OAuth flow, no consent screen, no account linking, and no
            on-chain call from the integrator. Reading somebody&rsquo;s standing is one
            unauthenticated GET.
          </Point>
          <Point label="And one deliberate absence" ink="protest">
            There is no <code className="font-mono text-xs">vouch()</code> and there never will be.
            Creating trust requires a present human inside the VouchMe app. The agent-facing MCP
            server ships 18 tools and not one of them can vouch for anybody.
          </Point>
        </Points>
      </Slide>

      {/* ── 09 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("fiar")} eyebrow="08 · the integration, worked end to end · fiar.davinciin.xyz">
        <Headline>Karma is a dial, not a door. Nobody is refused; everybody is priced.</Headline>
        <Lede>
          Fiar is a peer-to-peer lending library built on that SDK: borrow a drill from a neighbour,
          and your standing sets the deposit. Real WLD moves on World Chain, confirmed server-side
          against the World Developer Portal rather than trusted from the client.
        </Lede>
        <DataTable
          head={["Holder", "Score", "Deposit on the 0.03 WLD drill", "Reaches"]}
          numeric={[1, 2, 3]}
          rowInk={["protest", undefined, "seal", "anchor"]}
          rows={[
            ["ring1.eth · six-account collusion ring", "20.0", "0.0300 — full price", "2 / 6"],
            ["carol", "50.0", "0.0214", "2 / 6"],
            ["alice · Tier 1", "60.0", "0.0195", "5 / 6"],
            ["anchor1 · Orb anchor", "100.0", "0.0045", "6 / 6"],
          ]}
        />
        <Callout tone="protest">
          The ring is not blocked. It is simply not cheaper — and no code in Fiar had to know what a
          collusion ring is.
        </Callout>
        <Aside>
          Live figures against the fixture graph. The deposit falls by up to 75%, floored at 15% of
          the item&rsquo;s value — never zero, because a deposit of nothing is not a deposit. The
          Sybil resistance is inherited, not implemented: that first row is the whole thesis
          arriving inside another app&rsquo;s pricing function. Fiar is our own worked example of an
          outside integrator rather than a customer — it is deployed and it moves real WLD, but it
          is not traction.
        </Aside>
      </Slide>

      {/* ── 10 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("proximity")} eyebrow="09 · the read nobody else can answer">
        <Headline>&ldquo;anchor1 and anchor2 vouch for you both.&rdquo;</Headline>
        <Points>
          <Point>
            Fiar calls <code className="font-mono text-xs">proximity(borrower, owner)</code> and
            takes another 10% off the deposit when somebody vouches for both of them. On screen it
            is not a hop count and not a confidence percentage. It is a sentence naming two people.
          </Point>
          <Point label="Why this is structural" ink="seal">
            A nullifier has no neighbours. No proof-of-personhood credential can answer this
            question, because a one-bit answer has no graph around it to ask.
          </Point>
          <Point>
            Most integrations will write <code className="font-mono text-xs">if (tier &gt;= 1)</code>{" "}
            and stop. That throws away everything interesting about a score: a boolean can be
            extracted from one bit, and VouchMe publishes a number with a derivation attached.
          </Point>
        </Points>
        <Callout>
          One person&rsquo;s social standing, earned once, is legible to every app that wants it —
          and each of them decides for itself what it is worth.
        </Callout>
        <Aside>
          Every response carries <code className="font-mono">subgraphDeployment</code> and{" "}
          <code className="font-mono">computedAtBlock</code>. If you are charging somebody a
          different price because of their reputation, they should be able to check the reading you
          charged them on. Revocation is instant and free by design, so no verdict is ever cached.
        </Aside>
      </Slide>

      {/* ── 11 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("shipped")} eyebrow="10 · what is live, and what is not">
        <Headline>
          Six packages in one workspace, deployed — and a written list of what still isn&rsquo;t
          true.
        </Headline>
        <Cols>
          <Panel title="Shipped" ink="seal">
            <Points tight>
              <Point label="contracts">
                Foundry. Registry, reports, platforms, token vault, presence drip.{" "}
                <strong className="font-semibold">58 tests.</strong>
              </Point>
              <Point label="engine">
                One pure function: (accounts, vouches, reports, now) → scores. No I/O, no clock, no
                floats — integer centi-points, so identical inputs give byte-identical outputs
                anywhere it runs. <strong className="font-semibold">Zero dependencies, 60 tests.</strong>
              </Point>
              <Point label="subgraph">
                Contract events plus a standardized trust schema: one Substreams package, two
                protocols, five chains, zero per-protocol Rust.
              </Point>
              <Point label="gateway">
                A CCIP-Read wildcard ENS resolver computing text records at resolution time, signed
                for on-chain verification.
              </Point>
              <Point label="mcp">
                18 agent tools, importing the <em>same</em> engine the gateway runs, so an agent and
                a resolver can never disagree about a score.
              </Point>
              <Point label="app">
                A Next.js 15 World App mini app, 21 API routes. Deployed on World Chain mainnet,
                chain 480.
              </Point>
            </Points>
          </Panel>
          <Panel title="Not yet true" ink="protest">
            <Points tight>
              <Point>
                No users, no revenue, no traction to report. Everything in the left column is code
                and deployments.
              </Point>
              <Point>
                Both live enrolled humans are Orb anchors, whose score is fixed and ignores inbound
                edges — so the one live vouch changed no score. The trust-math demonstration runs on
                the seeded testnet deployment.
              </Point>
              <Point>
                Liveness is not enforced. It is unsatisfiable with the credential the wallet issues
                today.
              </Point>
              <Point>
                The deployed bytecode predates the project rename, so a redeploy is needed before
                chain and repo agree. All ENS writes are from one key.
              </Point>
              <Point>
                Fiar&rsquo;s deposit is a one-way transfer, not escrow. Returning it is a manual
                send, and the API says so in a <code className="font-mono">custody</code> field
                rather than implying otherwise.
              </Point>
            </Points>
          </Panel>
        </Cols>
        <Aside>
          Nothing is claimed from a deploy script&rsquo;s stdout — every address is re-read with{" "}
          <code className="font-mono">eth_getCode</code> from a fresh client. Where a repo file
          disagreed with the chain, the chain won, and the errata lists 19 numbered defects against
          our own spec.
        </Aside>
      </Slide>

      {/* ── 12 ────────────────────────────────────────────────────────────────────────────── */}
      <Slide {...at("ask")} eyebrow="11 · the ask">
        <Headline>
          One person&rsquo;s social standing, earned once, priced into any app that wants it.
        </Headline>
        <Cols>
          <Panel title="What the design already makes cheap — designed, not shipped">
            <Points tight>
              <Point label="Social recovery">
                The people who vouched for you are your recovery set, because that is already what
                vouching means. k-of-n of your active vouchers behind a 7-day timelock. No guardian
                list to configure, no seed phrase, no custodian.
              </Point>
              <Point label="ZK tier proofs">
                Prove <code className="font-mono text-xs">tier &gt;= 1</code> without revealing
                which account you are: verified standing, no stable identifier, no graph disclosure.
              </Point>
              <Point label="Offline NFC vouching">
                Two phones tap and both parties confirm; presence is already mandatory. An anchor
                with ten slots can ground ten people in ten minutes. The cold-start problem is
                solved at events, not online.
              </Point>
              <Point label="Agent-to-agent trust">
                Resolve an agent&rsquo;s ENS name, read{" "}
                <code className="font-mono text-xs">vouchme.tier</code>, price the interaction by
                its operator&rsquo;s standing. ENS is discovery, VouchMe is trust, x402 is
                settlement — and none of the three needed to know about the others.
              </Point>
            </Points>
          </Panel>
          <Panel title="The ask" ink="seal">
            <Points tight>
              <Point label="1 · integrate it" ink="seal">
                Call <code className="font-mono text-xs">standing(address)</code> on an address you
                already hold. One unauthenticated GET, three methods, zero runtime dependencies. The
                policy — what a score is worth — stays entirely yours.
              </Point>
              <Point label="2 · run a second indexer" ink="seal">
                The verifiability claim only means something if there is a second operator. Same
                events, same standardized schema, same engine module, different operator.
              </Point>
              <Point label="3 · adopt the schema" ink="seal">
                Trust and attestation is a protocol category with no standardized schema — eleven
                standard subgraph categories exist and not one of them is social trust. We wrote one
                and shipped its executable form.
              </Point>
            </Points>
          </Panel>
        </Cols>
        <Callout>
          Proof of human is a floor. Everything above it has to be earned from people who already
          stand on it.
        </Callout>
      </Slide>
    </>
  );
}
