# Using VouchMe karma from another World App mini app

VouchMe answers one question: *how much standing does this human have, and why.* It says nothing
about what that standing should buy. That is every integrator's decision.

This folder is a worked example of somebody else making it.

| | |
|---|---|
| [`vouchme-sdk/`](vouchme-sdk) | `@vouchme/minikit-sdk` — the whole integration surface. ~230 lines, zero runtime dependencies, HTTP only. |
| [`fiar/`](fiar) | **Fiar** — a peer-to-peer lending library. Borrow a drill from a neighbour. Your karma sets the deposit. |

## Why this is easy

A World App mini app already knows its user's wallet address from `MiniKit.walletAuth()`. That
address is the only join key VouchMe needs. There is no API key to request, no OAuth flow, no
consent screen, no account linking, and no on-chain call from the integrator. Reading someone's
standing is one unauthenticated GET.

```ts
import { createVouchMe } from "@vouchme/minikit-sdk"

const vouchme = createVouchMe({ baseUrl: "https://vouchme.example" })

const standing = await vouchme.standing(address)   // null if they have no VouchMe account
if (standing) {
  console.log(standing.score, standing.tier, standing.meta.computedAtBlock)
}
```

Three methods, and that is the entire API:

| Method | Answers |
|---|---|
| `standing(idOrAddress)` | score, tier, depth, credential status, and provenance. `null` when not enrolled. |
| `gate(address, policy)` | VouchMe's own promotion gates, with the reasons for a refusal. |
| `proximity(from, to)` | are these two people connected, and who vouches for both of them |

There is no `vouch()` and there never will be. Creating trust requires a present human inside the
VouchMe app; a third party may only read ([`docs/06-mcp-skills.md` §3](../docs/06-mcp-skills.md)).

## What Fiar does with it

Most integrations will write `if (tier >= 1)` and stop. That throws away everything interesting
about a score: a boolean can be extracted from one bit, and VouchMe publishes a number with a
derivation attached.

Fiar treats karma as a **dial**, not a door. Nobody is refused; everybody is priced.

```
k = clamp((score − 20) / (140 − 20), 0, 1)     // 0 at the enrollment floor, 1 at Tier 2

deposit = itemValue × max(0.15, 1 − 0.75k − connectionDiscount)
rate    = listRate  × max(0.50, 1 − 0.40k)
ceiling = $50 + $60 × tier
```

Four separate jobs for one number:

1. **Deposit** falls by up to 75%, floored at 15% of the item's value. Never zero — a deposit of
   nothing is not a deposit.
2. **Daily rate** falls by up to 40%, floored at 50%. Deliberately gentler: the deposit prices
   *risk*, which reputation genuinely reduces, while the rate prices *wear*, which it does not.
3. **Connection discount** — another 10% off the deposit when somebody vouches for both the
   borrower and the owner. This is the read no other personhood system can answer, because a
   nullifier has no neighbours. On screen it is not a hop count, it is a sentence: *"anchor1 and
   anchor2 vouch for you both."*
4. **Catalogue ceiling** rises with tier. Reputation does not only make borrowing cheaper, it makes
   more of the shelf reachable — which is the part people actually act on.

The item page shows the same item quoted at every rung of the ladder, with the viewer's own row
filed in among them, so climbing has a visible price attached before anyone climbs.

### What the demo shows

Point Fiar at a VouchMe graph and switch card holders:

The catalogue is everyday household things — $30 to $120 — so the bottom rung of the ladder still
reaches something. A ladder whose first rung reaches nothing is a wall, and teaches a new user that
their standing is worthless rather than merely small.

| Holder | Score | Deposit on a $45 drill | Reaches | Why |
|---|---|---|---|---|
| `ring1.eth` | 20.0 | **$45.00** — full price | 2 of 6 | Six accounts vouching for each other in a ring. Every edge contributes zero, so the ring pays exactly what a stranger pays. |
| `carol` | 50.0 | $32.06 | 2 of 6 | Tier 0 still, but 30 points above the floor — and directly vouched by the drill's owner, which is the extra 10% off. |
| `alice` | 60.0 | $29.25 | 5 of 6 | Tier 1, and both anchors vouch for her *and* for the owner. |
| `anchor1` | 100.0 | **$6.75** | 6 of 6 | Orb-verified anchor. Hits the 15% floor, and still is not free. |

Note the ring is not *blocked*. It is simply not *cheaper* — and no code in Fiar had to know what a
collusion ring is.

That first row is the whole thesis arriving inside somebody else's app.

## Reading is open. Borrowing is not.

Quoting a price needs no authentication — VouchMe scores are public, and Fiar will happily show
anyone what anyone else would pay. Sign-in exists for exactly one reason: the moment money moves,
Fiar has to know the person holding the phone controls the address whose reputation earned the
discount. Otherwise you type an anchor's address and borrow a camera at the 15% floor.

```
MiniKit.walletAuth()
  → POST /api/auth/nonce        server-issued, HMAC-signed, expiring, single-use
  → POST /api/auth/verify       viem verifyMessage with ERC-1271/6492 fallback
  → httpOnly session cookie, HMAC-bound to the verified address
```

The ERC-1271 fallback is not optional. World App wallets are **smart contract accounts**, so a
`walletAuth` signature is validated by calling the account contract, not by `ecrecover` — an
EOA-only check rejects every genuine World App user, and a counterfactual account that has never
transacted needs ERC-6492 on top.

Then `POST /api/borrow` decides the price. It does not trust the page the request came from:

- the address comes from the session cookie, **never** from the request body
- standing is re-read live and the quote recomputed
- if the client's number disagrees with the server's, it **409s** rather than charging either one
- the amount is sealed into an HMAC blob with a 5-minute expiry, and that seal is what gets charged

`?as=` is a browser preview affordance. A verified session outranks it, and the preview control
disappears once you sign in — the page can never show one identity while the server acts as another.

`npm run test:auth` covers all of it: forged cookie, wrong-nonce signature, nonce replay,
body-address override, client-chosen price, and a fabricated payment confirmation. 17 checks.

## Taking the deposit

`MiniKit.pay()` moves WLD on World Chain. The client gets a `transactionId` back — but the client is
exactly who a fraudulent client would be, so that payload proves nothing. The transfer is real only
once Fiar's server asks the **World Developer Portal** what happened, under its own API key:

```
POST /api/borrow        → mints a server-side `reference`, opens the payment
MiniKit.pay(reference)  → World App moves the WLD
POST /api/pay/confirm   → GET developer.worldcoin.org/api/v2/minikit/transaction/{id}
                          checks: our reference · mined · amount not short · same wallet as the session
```

The reference is what ties the halves together. Without checking it, any transaction id from any
payment in this app would confirm any deposit.

**Two numbers, both always shown.** The karma-derived deposit is a real dollar figure and it is the
product. What actually settles on chain is a fixed `FIAR_SETTLEMENT_WLD` (default **0.01 WLD**), so
the whole path runs with real money at a size nobody minds. They travel together in every API
response and sit side by side on screen. Set `FIAR_SETTLEMENT_WLD=0` to charge the true deposit.

**What this is not.** `pay()` is a one-way transfer, so the deposit sits in Fiar's payment wallet,
not in escrow. Returning it is a manual send — there is no contract enforcing the refund. The API
says so in a `custody` field and the UI says so under the receipt. An escrow contract driven by
`MiniKit.sendTransaction()` is what would make the refund a protocol instead of a promise.

Both rails need the app configured in the World Developer Portal: `FIAR_PAYMENT_RECIPIENT` must be
whitelisted under Payments, or World App refuses the transfer.

## Running it

Two servers. VouchMe on 3000, Fiar on 3100.

```bash
# 1. VouchMe, against its fixture graph (anchors, tiers, and the collusion ring)
cd app && NEXT_PUBLIC_CHAIN_MODE=fixture npm run dev

# 2. Fiar
cd example/fiar && cp .env.example .env.local   # then fill it in, see below
npm install && npm run dev
open http://localhost:3100
```

The catalogue works with nothing configured. Sign-in needs `FIAR_SESSION_SECRET`
(`openssl rand -hex 32`); payments additionally need `NEXT_PUBLIC_APP_ID`, `DEV_PORTAL_API_KEY` and
a whitelisted `FIAR_PAYMENT_RECIPIENT`. Each is missing-checked and fails closed with an error
naming what to set, rather than degrading quietly.

Point at a different deployment with `VOUCHME_API_URL`:

```bash
VOUCHME_API_URL=https://vouchme.example npm run dev
```

Outside World App, switch card holders with the preview control or `?as=<name>`. Inside World App,
`MiniKit.walletAuth()` supplies the address and the preview control does not render.

The same quote is available as JSON, so the integration can be checked rather than screenshotted:

```bash
curl 'http://localhost:3100/api/quote?item=drill&borrower=ring1.eth'
curl 'http://localhost:3100/api/quote?item=drill&borrower=anchor1.vouchme.eth'
```

## Things worth copying

- **`null` standing is not an error.** Most of the world has not enrolled. `standing()` returns
  `null` for them and Fiar quotes full price, which is the honest answer. An unreachable VouchMe is
  a *different* condition and Fiar reports it separately — conflating the two lets an outage read as
  "nobody here has any reputation" and silently reprices everything.
- **Show the provenance.** Every VouchMe response carries `subgraphDeployment` and
  `computedAtBlock`. If you are charging someone a different price because of their reputation, they
  should be able to check the reading you charged them on. Fiar prints it in the footer of every
  page.
- **Anchors need a special case.** An anchor's score is fixed at 100 and ignores every inbound vouch
  (FR-2), so it sits *below* the Tier 2 threshold of 140 and can never climb. Scaling a benefit
  naively across the score range charges the strongest credential in the system more than a
  well-vouched member.
- **Never cache a verdict.** Revocation is instant and free by design. The SDK sends
  `cache: "no-store"` and Fiar renders every page dynamically.
- **Fiar's policy is Fiar's.** Every constant in [`fiar/src/lib/policy.ts`](fiar/src/lib/policy.ts)
  is an opinion about lending, not a fact about VouchMe. The only two values borrowed from VouchMe
  are the ends of its scale.

MIT.
