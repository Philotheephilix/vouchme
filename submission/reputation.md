# How Aval computes a reputation score

The engine is one pure function: `compute(accounts, vouches, platformVouches, reports, now) -> scores`.
No I/O, no `Date.now()`, no randomness, no floats. 660 lines in
[`engine/src/score.ts`](../engine/src/score.ts), 60 tests, all passing.

Everything below was read out of the source and re-run against it. To check it yourself:

```bash
cd engine && npm test       # 60/60 pass, ~3s
```

Where [`docs/01-trust-math.md`](../docs/01-trust-math.md) disagrees with the engine, the engine is
authoritative and the disagreement is listed in [§9](#9-where-the-spec-and-the-code-disagree).

---

## 1. The problem a naive score fails at

"Sum the vouches you receive" fails three ways at once, and each failure is cheap to execute:

| Attack | Why the naive score loses |
|---|---|
| **Sybil ring** | Seven accounts vouch for each other. Every one of them is now well-vouched. Cost: seven phones on a table. |
| **Mutual vouching** | Trust becomes self-certifying. The uncapped form `S = 20/(1 − 0.25n)` solves for `n ≤ 3`, and above that the capped form `S = 20 + 20n` takes over — so a clique picks its own score by choosing its size. |
| **Whales** | One highly-trusted account mints members at will, so the entire graph is one compromised key away from worthless. |

The sybil ring is not a bug in the summation — it is a **valid solution to the scoring equation**.
With `base = 20`, `m⁺ = 0.25`, `cap⁺ = 20`, a complete graph of 7 accounts all sitting at `S = 140`
satisfies `S = 20 + 6 × min(0.25·S, 20)` exactly. It is arithmetically indistinguishable from a real
Tier 2 account. Detection cannot fix this, because there is nothing anomalous to detect; the numbers
are correct.

So the design cannot be "sum, then filter". It has to be a scoring rule under which the clique's
solution is **not the one computed**.

---

## 2. The core algorithm: least fixed point, computed outward from anchors

### 2.1 The equation

```
s⁺(u) = base + tenure(u) +   Σ   min( s⁺(v) × m⁺ , cap⁺ )
                          v ∈ A(u)
                        depth(v) < depth(u)
```

`A(u)` is the set of active inbound vouchers. The third line is the whole design.

`s⁺` depends on `s⁺` — circular, and the system has **many** solutions. Aval takes the **least** one,
and takes it constructively: BFS outward from the anchors, then one layered pass that computes each
depth strictly from the layer above it.

```ts
// engine/src/score.ts:370-381
for (let d = 1; d <= MAX_DEPTH; d++) {
  for (const id of byDepth.get(d) ?? []) {
    let sum = 0;
    for (const srcId of inboundVouches.get(id) ?? []) {
      const srcDepth = passDepth.get(srcId);
      if (srcDepth === undefined || !(srcDepth < d)) continue;   // ← strictly lower depth only
      sum += weightPos(passSp.get(srcId)!);
    }
    passSp.set(id, BASE + tenureOf(acct) + sum);
  }
}
```

Depth comes from a multi-source BFS over the origin set (`score.ts:305-328`), capped at
`MAX_DEPTH = 3`. Anchors are depth 0 with a fixed score; unreachable accounts get depth `∞` and
score `base + tenure`.

### 2.2 Why this *is* the anti-collusion rule

The anti-collusion property is not a check bolted onto the algorithm. It is a consequence of the
evaluation order:

> In a clique, no member is at strictly lower depth than any other member. Every term in every
> member's sum is therefore excluded, and each member's score reduces to `base + tenure`.

Nothing is detected. There is no ring-detection heuristic, no clustering pass, no anomaly score to
tune or evade. **The attack is not expressible in the computation.** A colluding group can add edges
until the graph is complete and the sum stays empty, because the sum only ever reads the layer
above, and a clique has no layer above.

Two independent defenses actually fire on a detached clique (errata E-7):

1. **Depth ordering** — every contribution term is excluded. Score = `base`.
2. **Gate 3** — no path of ≤ 3 active vouches to any origin exists at all. Tier 0 regardless of score.

Either alone is sufficient.

The clique solutions are still solutions — they are *greater* fixed points, true only because they
assume themselves. Iterating from `⊥ = anchors` reaches the least fixed point (Knaster-Tarski), which
is the one where trust has to be grounded in something outside the graph.

### 2.3 The second circularity: origins

Origins = anchors ∪ Tier 2, but Tier 2 depends on score, which depends on depth, which depends on
origins. Resolved the same way — an outer loop that only ever *adds* origins (`score.ts:395-416`):

```
O₀ = anchors
repeat:  depth ← BFS(O_k);  s⁺ ← inner pass;  T2 ← {u : s⁺ ≥ T2 ∧ gates};  O_{k+1} ← anchors ∪ T2
until O_{k+1} = O_k     (MAX_ROUNDS = 8, converges in 2-3 in practice)
```

The origin set is monotone in a finite set, so it stabilises. `converged: false` is published in the
output when `MAX_ROUNDS` is exhausted, rather than silently returning a half-finished answer.

### 2.4 The five stages

```
0  anchors                fixed at ANCHOR, ignore every inbound edge (E-6)
1  s⁺  human scores       BFS least fixed point; outer origins loop; reports IGNORED
2  s_P platform scores    from s⁺ only
3  d   report weights     from s⁺ / s_P only; voiding is a boolean, not a weight
4  s, s_risk              max(floor, s⁺ − Σ top-3 upheld weight)
5  tier(s), tier_P(s_P)   promotion gates
```

### 2.5 The gates

| # | Gate | Kills |
|---|---|---|
| 1 | `score ≥ 55` (T1) / `≥ 140` (T2) | under-supported accounts |
| 2 | ≥ 2 distinct **contributing** vouchers (strictly lower depth) | single points of trust |
| 3 | path ≤ 3 active vouches to an origin | detached components, long attenuated tails |
| 4 | no upheld report in the last 90 days (Tier 2 only) | accused accounts acting as path origins |

Gate 2 counting *contributing* vouchers rather than raw inbound edges is errata E-14 — see
[§8](#8-the-errata-worth-showing). Implementation: `distinctContributingVoucherCount`,
`score.ts:279-290`.

---

## 3. The constants, and why each has its value

Read from [`engine/src/constants.ts`](../engine/src/constants.ts). All values are **centi-points**
(score × 100) — integer arithmetic only, so two independent engines agree bit-for-bit.

| Constant | Value | Centi | Source | What it does |
|---|---|---|---|---|
| `BASE` | 20 | `2_000` | `constants.ts:13` | Everyone's floor. Granted by a World ID credential, not by other people. |
| `ANCHOR` | 100 | `10_000` | `constants.ts:16` | Fixed. Ignores all inbound edges (E-6). |
| `T1` | 55 | `5_500` | `constants.ts:42` | Tier 1 threshold. |
| `T2` | 140 | `14_000` | `constants.ts:45` | Tier 2 threshold — Tier 2 accounts become path origins. |
| `M_POS` | 0.25 | `25/100` | `constants.ts:25-26` | Mid-graph dial. Attenuation per hop. |
| `CAP_POS` | 20 | `2_000` | `constants.ts:19` | The whale ceiling. |
| `M_NEG` | 0.50 | `50/100` | `constants.ts:29-30` | Reports weigh double vouches. |
| `CAP_NEG` | 40 | `4_000` | `constants.ts:22` | One maximal report cancels two anchor vouches. |
| `MAX_DEPTH` | 3 | — | `constants.ts:56` | Also the ENS label limit: `carol.alice.aval.eth` is depth 2. |
| `MIN_VOUCHERS` | 2 | — | `constants.ts:59` | Gate 2. |
| `TOP_K` | 3 | — | `constants.ts:67` | Only the 3 heaviest valid reports count. |
| `T_MAX_CENTI` | 5.00 | `500` | `constants.ts:123` | Tenure ceiling. |
| `SLOTS_TIER_1 / 2` | 3 / 10 | — | `constants.ts:95-96` | Outbound vouch capacity. **Enforced in the contract, not the engine** — `AvalRegistry._slotsAvailable`, `contracts/src/AvalRegistry.sol:394`. |

### The invariants that pin these values

Each of these is a property of the numbers, verified by running them:

```
1.  base + T_MAX < T1                2000 + 500  = 2500 < 5500
    Presence alone can never promote anyone, at any age.            [test: I-17 (tenure half)]

2.  base + cap⁺ < T1                 2000 + 2000 = 4000 < 5500
    ONE voucher, however strong, can never reach Tier 1 alone.      [test: 12.1 — 1 anchor => 40]

3.  Two is never enough; three is.   2×1375 + 2000 = 4750 < 5500
                                     3×1375 + 2000 = 6125 ≥ 5500   [tests: 12.1 — 2 × T1@60,
                                                                            12.1 — 3 × T1@60]

4.  A detached clique scores exactly base.                          [tests: I-2, 12.1 — 7-account ring]

5.  cap binds at voucher score 80 = cap⁺/m⁺ — a pure ratio, independent of base.
    weightPos(10_000) = weightPos(14_000) = weightPos(1_000_000) = 2_000
    An anchor, a Tier 2 account, and a hypothetical 10,000-point whale all contribute
    exactly 20.00. There is no whale.
```

Item 5, verified directly against the engine's exported `weightPos`:

```
weightPos(2000)    = 500      weightPos(8000)      = 2000
weightPos(5500)    = 1375     weightPos(10000)     = 2000    ← anchor
weightPos(6000)    = 1500     weightPos(14000)     = 2000    ← Tier 2
weightPos(6500)    = 1625     weightPos(1000000)   = 2000    ← whale, same as anchor
```

---

## 4. Worked examples, actually run

Every block below is real output from `compute()` in `engine/dist`, on the graph described. Scores
are centi-points.

### 4.1 The minimal path to Tier 1: two anchors

```
1 anchor:    depth=1  s+=4000   score=4000  tier=0     20 + 20         = 40   < 55
2 anchors:   depth=1  s+=6000   score=6000  tier=1     20 + 20 + 20    = 60   ≥ 55
```

One anchor fails **both** gate 1 (40 < 55) and gate 2 (one contributing voucher).
Test: `12.1 — 1 anchor => 40, blocked (gate 1: below T1; gate 2: only 1 distinct voucher)` and
`12.1 — 2 anchors => 60, Tier 1` (`engine/src/score.promotion.test.ts:10, 22`).

Ordinary members are weaker than anchors, and this is where the headline property lives:

```
2 × Tier1@60:  s+=5000  tier=0    20 + 2×15 = 50   < 55   BLOCKED
3 × Tier1@60:  s+=6500  tier=1    20 + 3×15 = 65   ≥ 55   Tier 1
```

Tests: `12.1 — 2 × T1@60 => 50, blocked (gate 1: below T1) — two is never enough` and
`12.1 — 3 × T1@60 => 65, Tier 1 — three is enough`.

### 4.2 The minimal path to Tier 2: six anchors

```
5 anchors:   depth=1  s+=12000  tier=1    20 + 5×20 = 120  < 140
6 anchors:   depth=0  s+=14000  tier=2    20 + 6×20 = 140  ≥ 140
             origins=["A0","A1","A2","A3","A4","A5","U"]  converged=true
```

Note `depth=0` and `U` appearing in `origins` on the six-anchor run: the outer loop promoted `U` to
Tier 2, which made it a path origin, which re-rooted the BFS. Test:
`12.1 — 6 anchors => 140, Tier 2`.

Tier 2 is also reachable without any anchor being generous: `12.1 — 8 × T1@60 => 140, Tier 2` and
`12.1 — 12 × 1-anchor@40 => 140, Tier 2` both assert `s⁺ = 14_000` from ordinary members only.

### 4.3 The collusion ring scores exactly `base`

Seven accounts, complete graph (42 edges), no anchor:

```
R0..R6:  depth=Infinity  s+=2000  score=2000  tier=0     ← exactly BASE
         origins=[]  converged=true
```

Every member has 6 inbound vouches. Every one of them contributes **0**. The clique's own
self-consistent solution is `S = 20 + 6×20 = 140` (Tier 2); the engine computes `20`.

Test: `12.1 — 7-account mutual ring (complete graph, no anchor path) => 20.00, blocked ×3`
(`score.promotion.test.ts:169`). It asserts all three gates fail independently, and uses
`breakdown()` to prove the point observably: `bd.vouchers.length === 6` and
`bd.vouchers.every(v => !v.counted)` — six inbound rows, zero counted. Also asserted from the
invariant side by `I-2 — 7-account complete ring, no anchor path, scores exactly BASE + tenure`,
which repeats the test with 720 days of accrued presence and still gets `base + tenure`.

**Attaching the ring to a real anchor does not rescue it.** One anchor vouches for `R0`:

```
R0:      depth=1  s+=4000  tier=0     20 + 20               = 40
R1..R6:  depth=2  s+=3000  tier=0     20 + weightPos(4000)  = 30
```

`R1..R6` are all at depth 2, so their 5 mutual edges still contribute nothing; only `R0`'s edge
counts, and `R0` is worth 10.00 apiece. The ring bought one anchor and got 30.00 out of it.

Giving *every* ring member its own anchor is no better — all seven land at depth 1, so the ring
edges remain same-depth and worthless:

```
R0..R6:  depth=1  s+=4000  tier=0     each: 20 + 20 = 40, blocked by gate 2 as well
```

### 4.4 Trust does not travel single-file

The remaining escape route is a long thin chain: A vouches B vouches C vouches D, forever. The
recursion `f(s) = base + w⁺(s)` has fixed point `20/(1 − 0.25) = 26.67`, and the engine's own
truncate-toward-zero arithmetic lands one hundredth below it:

```
s = 2666 centi = 26.66 points   <   5500 = T1
```

**A chain of single vouches never promotes anyone, at any length** — before gates 2 and 3 are even
consulted. Test: `5.3 — single-vouch chain recursion converges to 26.66 and never reaches T1`, which
iterates the recursion 200 times from an anchor-strength seed and asserts both the fixed point and
that convergence is monotone from above.

---

## 5. Stratified evaluation, and the floor at `base`

### 5.1 Why negatives are computed in a strictly later stage (errata E-9)

Humans vouch for platforms. Platforms report humans. Naively:

```
platform reports human → human's platform-vouch weakens → platform's report weakens
                      → human recovers → platform's report strengthens → repeat
```

An oscillator with no fixed point. The fix is **stratification**: report weights are computed
exclusively from **positive-only** scores, in a strictly later stage than positive scores. Stage 1
ignores reports entirely (`score.ts` module doc, stages listed at lines 9-20). Stage 3 reads `s⁺`
and `s_P`, both already final. There is no feedback edge, therefore no cycle, therefore no
oscillation to damp, no convergence criterion to tune, and one deterministic pass.

Three consequences that fall out of the ordering:

- **A reporter's own reports do not weaken their reports.** Handled by a *boolean* at stage 3: an
  account under an upheld report has all of its outgoing reports voided (`voidReasonFor`,
  `score.ts:455-471`). Boolean, not weight — so still no loop.
  Test: `12.2 — report from a voided reporter has zero effect (65 stays 65, Tier 1)`.
- **A vouch from someone later reported still counts.** Reports subtract from the target, never from
  the target's vouchees. No cascade.
- **`s⁺` is the durable quantity.** Reports decay to zero over 180 days, so `s → s⁺` again.

Idempotence is asserted directly: `I-10 — running compute twice on identical input is idempotent and
input is not mutated`.

### 5.2 The floor is `base`, not 0 (errata E-8)

```ts
// engine/src/score.ts:564-567
const floorVal = BASE + tenureOf(u);
score.set(u.id, Math.max(floorVal, sPlusVal - sumUpheld));
scoreAtRisk.set(u.id, Math.max(floorVal, sPlusVal - sumRisk));
```

Two reasons, one mechanical and one substantive.

**Mechanical:** without a floor a score goes negative, and then
`min(negative × 0.25, 20)` is negative — a reported account would *subtract* from everyone it
vouched for. That is a cascade the design rejects outright.

**Substantive:** `base` is granted by a World ID credential, and `tenure` by presence you accrued
yourself. Neither is anyone's opinion. **A report can take away everything people gave you; it
cannot take away the fact that you are a live human.** Platforms floor at `0` instead, because a
service has no credential and no equivalent claim.

Verified across the whole report ladder, on a 6-anchor Tier 2 account (`s⁺ = 140`):

```
1 upheld maximal report:  140 − 40  = 100   Tier 1
2 upheld:                 140 − 80  =  60   Tier 1
3 upheld:                 140 − 120 =  20   Tier 0    ← floored at base, not 0
5 upheld:                              20   Tier 0    ← top-3 cap; reports 4 and 5 change nothing
```

Tests, all in `engine/src/score.reports.test.ts`:
`12.2 — Tier 2 (140): 1 upheld from a P2 platform => 100, Tier 1`,
`12.2 — Tier 2 (140): 2 upheld => 60, Tier 1`,
`12.2 — Tier 2 (140): 3 upheld => 20, Tier 0 (floored at base, not 0)`,
`12.2 — Tier 2 (140): 5 upheld => 20, Tier 0 (top-3 cap; reports 4 and 5 change nothing)`.

`I-12 — 20 reports filed against one target, only 3 apply` files twenty individually-valid maximal
reports and asserts `counted.length === 3`. Brigading buys nothing past the third report.

Report weight is `min(snapshotWeight, weightNeg(s⁺(reporter)))` (`score.ts:491`) — never more than
the bond you paid for, never more than your current standing justifies. Both directions are tested
(`R-1 — a promoted reporter cannot inflict more damage than their bonded snapshot`,
`R-1 — a demoted reporter cannot inflict more damage than their current standing justifies`).

### 5.3 Decay is a wound, not a brand

Linear decay to zero over 180 days from the upheld verdict. Run against a 2-anchor Tier 1 account
under one maximal report:

```
day   0:  score=2000  tier=0   report weight 4000
day  90:  score=4000  tier=0   report weight 2000
day 157:  score=5489  tier=0   report weight  511
day 158:  score=5512  tier=1   report weight  488   ← Tier 1 restored
day 180:  score=6000  tier=1   report weight    0   ← fully rehabilitated
```

This confirms errata E-16's claim that rehabilitation "now takes roughly 158 days, not 90" to the
exact day. Days 157 and 158 are runs, not fixtures; the suite covers the endpoints —
`12.2 — that report upheld: score drops to 20, Tier 0 (one maximal report ends Tier 1)`,
`12.2 — upheld report, 90 days later: score 40, Tier 0 still (...)`,
`12.2 — upheld report, 180 days later: score 60, Tier 1 (fully rehabilitated)`.
Pending reports never move a tier —
`12.2 — pending report from an anchor: score unchanged, scoreAtRisk drops` asserts `score` stays at
6000 while `scoreAtRisk` falls to 2000. An accusation is not a verdict.

---

## 6. Tenure / presence drip

`tenure(E) = T_MAX × (1 − 2^(−E / E_HALF))` — exponential saturation on claimed 6-hour presence
epochs, half-life 720 epochs (180 days), ceiling 5.00 points. Implemented as an exact integer
halving-band formula with **one** truncation (`engine/src/tenure.ts:46-62`).

Verified table:

```
tenureCenti(0)          = 0        tenureCenti(1440)      = 375   (1 year)
tenureCenti(1)          = 0        tenureCenti(2160)      = 437
tenureCenti(120)        = 41       tenureCenti(2880)      = 468   (2 years)
tenureCenti(360)        = 125      tenureCenti(11520)     = 500   (saturation, k=16)
tenureCenti(720)        = 250      tenureCenti(1_000_000) = 500
```

Test: `tenureCenti — exact table (16-presence-drip.md §4)`.

**Why the cap exists, and why it is 5.00:** tenure is a participation subsidy for people who have no
vouches yet — it makes the score move on day one without making it *mean* anything. The bound is
chosen so that

```
base + T_MAX  =  20 + 5  =  25  <  55  =  T1
```

**Showing up can never promote anyone, at any age.** Asserted twice: as pure arithmetic in
`I-17 (tenure half): base + T_MAX_CENTI < T1 — presence alone can never promote`, and end-to-end in
`I-17 — 1,000,000 claimed epochs + zero vouches => score 25 (2500 centi), Tier 0` — a million epochs
is roughly 685 years of continuous presence, and the account is still Tier 0.

Tenure also raises the *floor* (`base + tenure`, `score.ts:564`), so presence you accrued yourself is
protected from reports on the same grounds as the credential. The clique test asserts this too: a
7-account ring with 720 days of presence each scores exactly `base + tenure`, not one point more.

---

## 7. What is in the engine, and what is not

| Enforced in the engine | Enforced elsewhere |
|---|---|
| gates 1-4, depth, contributions, report weights, decay, top-K, voiding, tenure, tiers | vouch **slots** (3 / 10) — `AvalRegistry._slotsAvailable`, reverts `NoSlots` |
| edge dedup by `(voucher, vouchee)` | rate limits (1 new vouch / 24h) — contract |
| anchor score fixed at 100 | anchor status itself — read live from the Address Book |

The engine treats a vouch list as a **set**: duplicated records for the same ordered pair collapse to
one canonical edge before anything reads them (`dedupeVouches`, `score.ts:118-128`). An indexer
replay cannot inflate a score. Tests: the four `R-2 —` cases.

---

## 8. The errata worth showing

The full list is [`docs/99-errata.md`](../docs/99-errata.md). E-1 through E-10 came from review.
**E-11 through E-15 were found by implementing the spec and by tests asserting the spec's own worked
tables** — five defects that a review pass had already walked past, including the only one classed as
a blocker.

### E-11 — the integer tenure formula contradicted its own table

The doc's halving-band pseudocode read `lo = 500 - (500 >> k)`. The shift truncates *before* the
subtraction, pushing `lo` up whenever the division is inexact: at `k=3` it yields **438** where the
doc's own printed table says **437**; at `k=4`, 469 vs 468. Both forms agree for `k ≤ 2`, so the
error was invisible until an account is 18 months old.

Fix: fold the band interpolation into a single rational so exactly one truncation happens
(`tenure.ts:59-61`), and clamp at `k ≥ 16`. Without the clamp the asymptotic curve returns 499
forever and invariant I-17 fails at 2499 centi instead of 2500 (`tenure.ts:26-31`). Caught by the
contracts implementation.

### E-14 — an unreachable table row, and a hole in gate 2

`docs/01-trust-math.md` §12.1 carried a row reading `1 anchor + 1 Tier 1 → 37.5 → Tier 1`.

It was unreachable. An anchor vouch puts the target at depth 1. A Tier-1 account cannot be at depth 0
— depth 0 means anchor or Tier 2 origin, and Tier 2 needs score ≥ 140. So the Tier-1 voucher sits at
depth ≥ 1, which is not *strictly lower*, and contributes exactly **0**.

Worse, the row exposed a hole in gate 2 as originally worded. Two inbound edges existed, so the gate
passed, and the account reached Tier 1 **on one anchor plus one worthless edge** — defeating the gate
whose entire purpose is that no single anchor can mint members.

Fix: gate 2 counts **contributing** vouchers, not inbound edges (`score.ts:279-290`). Consequences:
the row is Blocked; the detached clique now fails all three gates instead of two; and the
zero-contribution rows the UI renders stopped being decoration and became the difference between
promotion and rejection. Test: `12.1 — 1 anchor + 1 non-contributing peer => 40.00, Tier 0, BLOCKED
(both gates fail)`.

### E-15 — the reference loop reset promoted origins to `base` (proof-breaking)

The spec's reference pseudocode re-initialised `sp` at the top of every outer round:

```python
sp = {u: (ANCHOR if u in anchors else BASE) for u in acc}
```

then recomputed only depths `1..max_depth`. A node promoted to Tier 2 in round `k` becomes an origin
in round `k+1` and therefore sits at depth **0**, which the inner pass never visits. So a Tier 2
account at 140 **silently collapses to 20** the moment it is promoted, taking every downstream
contribution with it.

Not cosmetic: round `k+1` scores come out *lower* than round `k`, so the monotonicity argument fails,
the origin set can shrink, and the loop can oscillate instead of converging. The termination proof
was false as written.

Fix: a non-anchor origin **carries forward** the `s⁺` it held in the round that promoted it
(`persistedSp`, `score.ts:343-344, 353-355, 412-415`). Caught by the engine implementation, not by
review. Classed **Blocker** in the errata summary.

### E-16 — raising `base` forced `T1` and `T2` to move, and changed real properties

The requested change was one number: `base` 10 → 20. Nothing else was asked to move.

Leaving `T1 = 30` would have meant `20 + 2×7.5 = 35 ≥ 30` — **two ordinary vouchers promote**,
destroying the design's central published property. `T1 = 55` is the tightest threshold that restores
it (`2×13.75 + 20 = 47.5 < 55 ≤ 61.25 = 3×13.75 + 20`). `T2 = 140` because six anchors then land
exactly on it (`20 + 6×20`).

What actually changed, beyond relabelled numbers:

1. **The "two is never enough" attenuation layer moved from depth 3 to depth 2.** `base` doubled (a
   flat +20 at every depth) while a depth-1 voucher's capped contribution only grew 12.5 → 15.00.
   Test `9.1 — depth 2, 2 × d1@60 => 50, blocked (the ladder shifts one level in — errata E-16)`
   asserts the new behaviour; at the old constants that same shape was comfortably Tier 1.
2. **Reach per anchor shrank from ≈ 20 to ≈ 15 people**, since the 3-voucher layer starts a
   generation earlier.
3. **The smallest self-certifying clique grew from 6 accounts to 7** — "six phones on a table" became
   seven. That is why every ring fixture in the suite is 7 accounts.
4. **The sybil-farm yield from two colluding Tier-2 accounts dropped from ≈ 40 to ≈ 30.**
5. **Rehabilitation got slower.** At the old constants, 90 days of decay landed a 2-anchor account
   exactly back on `T1`. Now it lands on 40 < 55, and recovery takes 158 days — the exact figure
   reproduced in [§5.3](#53-decay-is-a-wound-not-a-brand).

None of (1)-(5) was requested or anticipated. They surfaced because the worked tables were encoded as
test fixtures and stopped matching.

---

## 9. Where the spec and the code disagree

Found while writing this document, by running the engine against the doc's claims. Every item below
carries the fixture that produces it and the output it produced, so each is reproducible in about a
minute. Helpers used throughout:

```js
import { compute } from "./engine/dist/score.js";
const H  = (id) => ({ id, kind: "human" });
const A  = (id) => ({ id, kind: "human", isAnchor: true });
const P  = (id) => ({ id, kind: "platform" });
const V  = (voucher, vouchee)  => ({ voucher, vouchee, active: true });   // note: `active`, not expiry fields
const PV = (voucher, platform) => ({ voucher, platform, active: true });
const REP = (id, reporter, target, state, o = {}) =>
  ({ id, reporter, target, state, snapshotWeight: 4000, ...o });
const IN = (p) => ({ now: 0, accounts: [], vouches: [], platformVouches: [], reports: [], ...p });
const DAY = 86400;
```

### 9.1 — Invariant I-4b is false as worded, and nothing tests it

`docs/01-trust-math.md` §16 states "**Scores are non-decreasing across outer rounds**", and §6.2's
termination argument rests on the premise that "adding origins can only lower depths → can only
admit more `depth(v) < depth(u)` terms → can only raise scores".

Lowering a *target's* depth can also **remove** terms. The counterexample needs one property that is
easy to omit: the target must have same-depth vouchers that are anchored **independently** of the
account being promoted. If its other vouchers hang off the promoted account itself, they sit at the
target's own depth in both runs, contribute 0 in both, and no score change is visible — only a depth
change.

```js
// Only the anchor count on U changes between runs.
//   A0..A(n-1) -> U        U's own support
//   B1, B2     -> X        X anchored INDEPENDENTLY of U
//   B1, B2     -> Y        Y anchored INDEPENDENTLY of U
//   U, X, Y    -> W        W vouched by all three
const anchors = Array.from({ length: n }, (_, i) => A(`A${i}`));
compute(IN({
  accounts: [...anchors, A("B1"), A("B2"), H("U"), H("X"), H("Y"), H("W")],
  vouches: [
    ...anchors.map((a) => V(a.id, "U")),
    V("B1", "X"), V("B2", "X"),
    V("B1", "Y"), V("B2", "Y"),
    V("U", "W"), V("X", "W"), V("Y", "W"),
  ],
}));
```

Output:

```
anchors on U = 4  (U is NOT an origin)      anchors on U = 6  (U IS an origin)
  U  depth=1  s+=10000  tier=1                U  depth=0  s+=14000  tier=2
  X  depth=1  s+=6000   tier=1                X  depth=1  s+=6000   tier=1
  Y  depth=1  s+=6000   tier=1                Y  depth=1  s+=6000   tier=1
  W  depth=2  s+=7000   tier=1                W  depth=1  s+=4000   tier=0

anchors on U = 5  (U is NOT an origin)      anchors on U = 7  (U IS an origin)
  U  depth=1  s+=12000  tier=1                U  depth=0  s+=16000  tier=2
  W  depth=2  s+=7000   tier=1                W  depth=1  s+=4000   tier=0
```

`W` is vouched by `U`, `X` and `Y` in every run. Making `U` **stronger** demotes `W` from Tier 1 to
Tier 0. Once `U` crosses `T2` it becomes an origin at depth 0, `W` moves from depth 2 to depth 1, and
`X` and `Y` — now at equal depth — stop contributing:

```
W (U not promoted) = 20 + w⁺(U) + w⁺(X) + w⁺(Y) = 20 + 20 + 15 + 15 = 70.00   Tier 1
W (U promoted)     = 20 + w⁺(U)                 = 20 + 20             = 40.00   Tier 0
```

**Control, isolating origin status as the sole cause.** Same 6-anchor graph, but an upheld report on
`U` inside the 90-day gate-4 window blocks its promotion. `U`'s `s⁺` is untouched at 14000 and it
still contributes the capped 2000 — only its origin status differs:

```js
compute(IN({
  now: 10 * DAY,
  accounts: [...anchors6, A("B1"), A("B2"), A("RPT"), H("U"), H("X"), H("Y"), H("W")],
  vouches: [ /* identical to above */ ],
  reports: [REP("r1", "RPT", "U", "upheld", { upheldAt: 5 * DAY })],
}));
```

```
origins include U? false
  U  depth=1  s+=14000  score=10112  tier=1
  X  depth=1  s+=6000   score=6000   tier=1
  Y  depth=1  s+=6000   score=6000   tier=1
  W  depth=2  s+=7000   score=7000   tier=1     ← 7000, not 4000
```

Identical topology, identical `s⁺(U)`, identical contribution from `U`. The only variable is whether
`U` is an origin, and it is worth 30.00 points and one tier to `W`. This run is also a direct reading
of round 0 of the 6-anchor case, since a loop that never promotes anything converges with round 0's
values: within one `compute()` call on the 6-anchor graph, `W`'s `s⁺` is 7000 in round 0 and 4000 in
round 1.

**What this does and does not break.** Termination is unaffected: the implementation's `originsSet`
only ever grows over a finite set (`score.ts:414`), so the loop terminates regardless of whether
scores are monotone. The *conclusion* of §6.2 holds; the stated *reason* does not, and I-4b is false
as written — its narrow half ("a promoted Tier 2 origin never drops to `BASE` on becoming an origin",
which is E-15) does hold. The recommended correction is to rest §6.2 on origin-set growth over a
finite set, and to narrow I-4b to the promoted origin's own score. The phenomenon is acknowledged in
§17 case 13 ("a voucher's depth changes so their edge stops contributing"), but as something that
happens *between* recomputes — not within one. Nothing in the suite asserts I-4b.

### 9.2 — `scoreAtRisk` applies top-K once to the union, not twice

§3's stage-4 line reads `s_risk = max(floor, s⁺ − Σd_upheld − Σd_pending)`, which reads as two
separately-capped sums — a 240-point maximum. The code ranks all valid reports of any state together
and takes the top 3 (`score.ts:554-558`), so the maximum is 120. §15's reference pseudocode matches
the code; §3's prose does not.

```js
const anchors = Array.from({ length: 20 }, (_, i) => A(`A${i}`));
const rp = Array.from({ length: 6 }, (_, i) => A(`RP${i}`));
compute(IN({
  accounts: [...anchors, ...rp, H("U")],
  vouches: anchors.map((a) => V(a.id, "U")),
  reports: [
    REP("u1", "RP0", "U", "upheld", { upheldAt: 0 }),
    REP("u2", "RP1", "U", "upheld", { upheldAt: 0 }),
    REP("u3", "RP2", "U", "upheld", { upheldAt: 0 }),
    REP("p1", "RP3", "U", "pending"),
    REP("p2", "RP4", "U", "pending"),
    REP("p3", "RP5", "U", "pending"),
  ],
}));
```

```
s+ = 42000   score = 30000   scoreAtRisk = 30000
counted toward score: u1, u2, u3
counted toward risk : p1, p2, p3
docs §3 stage-4 reading (s+ − Σupheld_top3 − Σpending_top3) = 18000
```

Three maximal pending reports on top of three maximal upheld ones move `scoreAtRisk` by nothing. The
code's reading is the defensible one: otherwise filing pending reports would double an attacker's
damage cap for free, since pending reports carry no verdict and cost only the bond.

### 9.3 — Platform negatives are stricter in the code than in the pseudocode

§15's stage 2 computes `neg` as a plain sum over upheld reports — no `TOP_K`, no `snapshotWeight`
minimum, no decay. The engine applies all three to platforms exactly as it does to humans
(`score.ts:505-520`). A platform vouched by 8 anchors (`s_P = 160.00`), reported by anchors:

```
TOP_K:    3 upheld => s_P = 4000 (P1);  5 upheld => s_P = 4000 (P1)   ← identical
          §15 pseudocode sums all five: 16000 − 5×4000 → clamped to 0 (P0)
decay:    3 upheld at day 90 => s_P = 10000 (each weight 2000, was 4000)
          §15 has no decay term at all: would stay 4000
snapshot: 1 upheld with snapshotWeight = 500, filed by an anchor (live weight 4000)
          => baseWeight = 500, s_P = 15500 (16000 − 500), still P2
          §15 ignores snapshotWeight: would give 12000
```

Each divergence is in the direction of the code being harder to abuse: brigading a platform is capped,
old accusations fade, and a reporter cannot inflict more than the bond it posted.

### 9.4 — `score(r)` vs `s⁺(r)` in §7.1 is notational, and provably unobservable

I initially listed this as a substantive disagreement. It is not, and the run shows why.

§7.1 writes report weight as `min(snapshotWeight, score(r) × m⁻, cap⁻)` using `score`; the code uses
`s⁺` (`score.ts:485`), which is what §3's stratification requires. But the two can only differ when
the reporter is carrying an upheld report of its own — and that is exactly the condition that voids
every report it files. `R` is a 2-anchor Tier 1 with one upheld report against it, filing a report
against `U`:

```
day   0: s+(R)=6000 score(R)=2000  R's report valid=false (reporter_voided) weight=0
day  90: s+(R)=6000 score(R)=4000  R's report valid=false (reporter_voided) weight=0
day 179: s+(R)=6000 score(R)=5978  R's report valid=false (reporter_voided) weight=0
day 180: s+(R)=6000 score(R)=6000  R's report valid=true                    weight=0
day 181: s+(R)=6000 score(R)=6000  R's report valid=true                    weight=0
```

Whenever `score(R) < s⁺(R)`, `R` is voided and contributes 0 regardless of which quantity the formula
names. At day 180 the report against `R` decays out, `R` is un-voided, and `score(R) == s⁺(R)` again
— because voiding and decay run on the same 180-day clock by design (`score.ts:48-52`). The
implication chain is tight: `score(R) < s⁺(R)` requires an upheld report against `R` with non-zero
decayed weight, which requires `now − upheldAt < 180d`, which is precisely the predicate
`isVoidedReporter` tests. **On well-formed input, a documentation wording fix, not a defect.**

**One exception, and it is a validation gap rather than a scoring one.** `Report.upheldAt` is typed
optional with the comment "Required when `state === 'upheld'`" (`types.ts:57-58`), and nothing
enforces it — `compute()` checks that `upheldAt` is a finite integer *when present* (R-6,
`score.ts:203-209`) but never checks that it is present. Feed it `state: "upheld"` with no
`upheldAt`:

```
s+(R)=6000  score(R)=2000  (differ? true)
R's outgoing report: valid=true  voidReason=-  baseWeight=3000  decayed=3000
observed damage to U = 3000        // = weightNeg(s+ 6000); weightNeg(score 2000) would be 1000
```

Such a report never decays (`decayedWeight` returns the base weight unchanged) and never voids its
reporter (`hasRecentUpheldReport` requires `upheldAt !== undefined`), so `R` keeps full standing as a
reporter while carrying a live upheld report. Here the two readings of §7.1 *do* diverge, and the
code's `s⁺` reading is the harsher one. The honest framing: the wording difference is unobservable on
valid input, and the input that makes it observable is one the engine should be rejecting at the door
and does not.

### 9.5 — the doc's `T1 @ 55` rows are algebra, not engine output

The `T1 @ 55` table rows describe a voucher sitting exactly on the threshold; the tests substitute
`T1 @ 60` (a 2-anchor account), because that is what an actual graph produces. A score of exactly
5500 *is* constructible — a depth-2 account vouched by a 4-anchor node and a 2-anchor node:

```
P100  depth=1  s+=10000  tier=1      (4 anchors)
P60   depth=1  s+=6000   tier=1      (2 anchors)
T     depth=2  s+=5500   tier=1      2000 + 2000 + 1500 = 5500 = T1 exactly
```

No fixture builds one, so those rows are unverified by the suite even though they are arithmetically
right.

---

## 10. Honest limitations

**10.1 — The negative half of the math is not wired to the live app.** `app/src/lib/chain.ts` reads
`Enrolled` / `Vouched` / `Reaffirmed` / `Revoked` from `AvalRegistry` and presence from
`PresenceDrip`. It never reads `ReportRegistry` or `PlatformRegistry`, and hands the engine:

```ts
// app/src/lib/chain.ts:772
const engineInput: EngineInput = { now, accounts, vouches, platformVouches: [], reports: [] };
```

Both contracts are deployed and their addresses are carried in the `meta.contracts` envelope
(`chain.ts:133-156`), but nothing queries them. So in the live app, reports and platform vouches are
**always empty** — the entire negative half of the math (report weights, voiding, top-K, decay,
conflict-of-interest, platform scoring) is specified, implemented and tested, but not observable in
the deployed UI. It runs only against the fixture graph.

To the app's credit it does not lie about this: `GraphContext` carries `reportsAvailable` and
`platformsAvailable` booleans specifically so screens can say "we didn't look" rather than
"there are none" (`app/src/lib/mock.ts:298-303`).

**10.2 — On World Chain mainnet, the ladder is unobservable.** Mainnet anchors come from World ID's
real Address Book, so **every Orb-verified human who enrolls is an anchor**. By E-6 an anchor's score
is fixed at 100 and ignores all inbound edges, which means vouching for a verified human on the
mainnet deployment changes nothing at all. The deployment record states this plainly rather than
hiding it (`deployments/worldchain-mainnet.json`, `noSeededGraph`):

> "every Orb-verified human who enrolls here is a depth-0 anchor with a FIXED score of 100 that
> ignores all inbound vouches (errata E-6), so on this deployment vouching for a verified human
> changes nothing. That is the spec behaving as written, and it contradicts the product's own thesis
> that proof-of-human is the floor rather than the ladder."

The engine is correct; the anchor *set* is wrong for the demonstration. The trust graph — including
the on-chain collusion ring — lives on the World Chain Sepolia deployment
(`deployments/worldchain-sepolia.json`), where `GenesisAnchorBook` seeds a small anchor set and the
ladder has somewhere to climb. Mainnet exists only because MiniKit refuses to send a transaction on
any chain but 480.

**10.3 — Non-convergence is surfaced, not handled.** If the outer loop exhausts `MAX_ROUNDS = 8`
while still admitting origins, the engine finalizes bookkeeping and returns `converged: false`
(`score.ts:418-428`). It does not retry, and a promotion depending on the last round's new origins
may be missing. Deliberate — re-running the search on adversarial input could loop forever — but it
is a caller's problem that no caller currently handles.

**10.4 — Slots are a contract property, not an engine property.** `SLOTS_TIER_1 = 3` and
`SLOTS_TIER_2 = 10` are exported from `constants.ts` for the UI, but `compute()` never reads them. An
`EngineInput` with a thousand outbound vouches from one Tier 1 account scores exactly as given. The
constraint that makes the growth model work lives in `AvalRegistry.vouch()`.

**10.5 — `upheld` reports are not required to carry `upheldAt`.** The type says they must
(`types.ts:57-58`); `compute()` validates the field's *format* when present but never its
*presence* (`score.ts:203-209`). A report in that shape never decays and never voids its reporter.
Worked through with output in [§9.4](#94--scorer-vs-sr-in-71-is-notational-and-provably-unobservable).
One `if` in the same validation block that already exists would close it.

**10.6 — Two engines are claimed, one exists.** Invariant I-7 ("Python and TypeScript engines agree
bit-for-bit on golden fixtures") is the stated reason all arithmetic is integer centi-points. Only the
TypeScript engine is in this repo (`find . -name '*.py'` outside dependencies returns nothing). The
integer discipline itself is real and its *direction* is pinned by fixtures — `explain.test.ts:66`
asserts a contribution of `1_437`, i.e. `trunc(14.375)` rounded toward zero rather than to 14.38, and
the chain test lands on 2666 rather than the continuous 2666.67 — but no test is labelled I-15 or
I-19, and the cross-implementation check those invariants exist to enable has not been performed.
