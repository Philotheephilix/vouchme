# Aval — World ID / World App / World Chain

Aval is a trust graph: humans vouch for humans, and a score falls out of the graph. World ID is what
keeps that graph from being a self-referential fiction. This document says exactly where it sits,
how the integration works, what is on chain right now, and what is not built.

Every number, address, hash and quote below was read from the repo or from World Chain mainnet while
writing this. Commands to reproduce them are at the end.

---

## 0. The 60-second version

| | |
|---|---|
| Chain | World Chain mainnet, **480** — not by preference, see §4 |
| Anchors | World ID Address Book `0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D`, read live, never cached |
| Credential | `selfieCheckLegacy()` (World ID **3.0** proofs) via IDKit 4.2.1 |
| Action | `aval-enroll-v1` — **one** action for enrollment *and* vouching, deliberately (§3) |
| Live on chain | 6 contracts, **2 enrolled humans**, **1 vouch**, 0 revocations |
| Sent from | World App Safe smart accounts, through ERC-4337 EntryPoint v0.7 |
| Biggest honest gap | Both live humans are Orb anchors, so the one live vouch **changed no score at all** (§6) |
| Second gap | Liveness (`require_user_presence`) is **not enforced** — it is unsatisfiable with this credential (§5, E-19) |

---

## 1. Why the graph needs World ID at all

Aval's score is defined by a mutually recursive equation: your score depends on your vouchers'
scores, which depend on theirs. That equation has **infinitely many solutions**. One of them is the
honest one. Others are self-supporting cliques that award themselves Tier 2 out of nothing — a ring
of six accounts that all vouch for each other is a perfectly valid fixed point of "trust flows from
trusted people".

The engine resolves this by taking the **least** fixed point, computed by iterating upward from a
known bottom (`engine/src/score.ts`, `originsSet` → `persistedSp`). A least fixed point needs a
bottom. **The anchor set is the bottom**, and Orb verification is what defines it:

```solidity
// contracts/src/AvalRegistry.sol:318
function isAnchor(address a) public view returns (bool) {
    return addressBook.addressVerifiedUntil(a) > block.timestamp;
}
```

```ts
// engine/src/constants.ts:16
/** An anchor's score is fixed here and ignores all inbound edges (E-6): 100.00 points. */
export const ANCHOR = 10_000;
```

Orb verification is the only claim in Aval that does not depend on any other claim in Aval. Everything
else — every score, every tier, every slot allowance — is downstream of it.

Run the real engine on a fully-connected 6-account ring with no anchor anywhere in it — every account
vouching for every other account, 30 edges:

```
scores: {a:2000, b:2000, c:2000, d:2000, e:2000, f:2000}   # 20.00 each — the base, nothing more
tiers : {a:0, b:0, c:0, d:0, e:0, f:0}
```

Thirty mutual vouches buy exactly zero, because none of them is reachable from an anchor. That is what
World ID is doing here.

Two consequences the code actually implements:

- **Anchor status is read live, never cached.** The Address Book returns an *expiry*, and Orb
  verification lapses. A cached boolean would be a permanent backdoor for anyone whose verification
  lapsed. `app/src/lib/chain.ts` re-reads `addressVerifiedUntil` on every graph fetch (batched through
  Multicall3 so it costs one request, not N).
- **The app refuses to guess the anchor label.** On testnet the anchor set came from a stand-in
  contract; `app/src/lib/chain.ts` will only report `"world-id-orb"` when the *configured book address
  is the canonical Address Book*, and otherwise demands the stand-in identify itself as
  `"genesis-testnet"` or throws. A revert is never read as "these must be Orb anchors."

---

## 2. Enrollment, end to end

Files: `app/src/app/enroll/page.tsx`, `app/src/app/api/enroll/rp-context/route.ts`,
`app/src/app/api/enroll/route.ts`, `app/src/lib/attestation.ts`, `contracts/src/AvalRegistry.sol`.

**1. Handle check** — `GET /api/enroll/handle?h=…` (this reserves the ENS label; see `submission/ens.md`).

**2. Signed RP context, server-side only.** IDKit 4.x requires every request to carry an
`rp_context` signed with the RP signing key. It cannot be produced in the browser without shipping
the key, so it is a route handler:

```ts
// app/src/app/api/enroll/rp-context/route.ts:32
sig = signRequest({ signingKeyHex: key, action, ttl: 300 });
```

`export const dynamic = "force-dynamic"` — fresh nonce and 300s window per request, never cached.

**3. IDKit widget.** `app/src/app/enroll/page.tsx:482`:

```tsx
<IDKitRequestWidget
  app_id={config.appId}            // app_706e68bdf52ea24ffa03e6929614325e
  action={config.action}           // aval-enroll-v1
  rp_context={rpContext}
  allow_legacy_proofs={true}
  require_user_presence={false}
  preset={selfieCheckLegacy({ signal: auth.address })}   // signal = the wallet being enrolled
  onSuccess={handleProofSuccess}
/>
```

**4. Selfie Check** runs in World App: device-camera liveness plus weak facial uniqueness. The SDK's own
docstring for this preset opens with *"Preview: Selfie Check is currently in preview. Contact us if you
need it enabled."*, and `docs/03-worldid.md` §1 quotes World's documentation describing it as a
low-assurance credential offering weaker Sybil resistance than iris scanning. Aval does not pretend
otherwise — the premise of the product is that proof-of-human is weak on its own and a trust graph is
the right structure to compensate. **This is also why enrollment records `keccak256("selfie-check")` on
chain even for the two members who are in fact Orb-verified**: the credential field is the *path taken
at enrollment*, and anchor status is a separate, live read of the Address Book. `CRED_ORB` is defined
in `app/src/lib/attestation.ts` and never used by the enroll route.

**5. Server verification.** `POST /api/enroll` re-derives the signal hash with the *same* primitive
IDKit used client-side, then calls World's verify endpoint:

```ts
// app/src/app/api/enroll/route.ts:82
const expectedSignalHash = hashSignal(address);
…
verifyRes = await fetch(`https://developer.world.org/api/v4/verify/${rpId}`, { … })
```

The signal check has to be ours. World's endpoint confirms a proof is internally consistent; it never
learns which address we intend to enroll. Without the local comparison, a caller could generate a proof
for address A and POST it claiming `address: B`.

**6. Nullifier.** Read from `results[0].nullifier`, never the top level — the design doc flags this as
the one failure mode no test surfaces, because reading the wrong field makes uniqueness silently do
nothing. Converted straight to `bigint` and kept as a decimal string thereafter; a JS `Number`
truncates above 2⁵³ and truncated nullifiers collide.

**7. EIP-712 attestation.** The server signs `EnrollAttestation(address account, uint256
nullifierHash, bytes32 credential, uint64 deadline, uint256 nonce)` with `ATTESTOR_PRIVATE_KEY`
(`app/src/lib/attestation.ts:83`), domain `{ name: "AvalRegistry", version: "1", chainId: 480,
verifyingContract }`, TTL 285s.

**8. `enroll()` on World Chain.** Submitted by the user's own wallet — inside World App via
`MiniKit.sendTransaction`, outside it via the injected provider. The contract enforces:

```solidity
// contracts/src/AvalRegistry.sol:201
if (members[msg.sender].enrolled) revert AlreadyEnrolled();
if (usedNullifier[nullifierHash]) revert NullifierUsed();   // ← one account per World ID
…
_consumeAttestation(structHash, deadline, attestation);     // deadline + single-use digest + allowlisted signer
usedNullifier[nullifierHash] = true;
```

**Note a difference from the design doc.** `docs/03-worldid.md` §2.2 specifies a Postgres
`UNIQUE (action, nullifier_hash)` constraint. This build has **no database at all** (`app/package.json`
has zero DB dependencies). Uniqueness is enforced by `usedNullifier` on chain, and the API's pre-check
is a courtesy that produces a good error message. This is stronger than the spec, not weaker — the
constraint is public and auditable, and there is no concurrency race to lose.

---

## 3. Nullifiers: the anti-Sybil core

World ID nullifiers are scoped **per app, per action**, and are *deliberately unlinkable across
actions*. That unlinkability is the whole privacy property the scheme exists to provide.

An earlier design used a separate `aval-vouch-v1` action and claimed the backend would map the vouch
nullifier back to the enrollment nullifier. **That mapping cannot exist** — not for Aval, not for
anyone. It was caught before implementation (errata E-1) and `aval-vouch-v1` is now recorded as a
retired string that must never be used.

So both flows use **one action, `aval-enroll-v1`**, and the two properties are split cleanly:

| Question | Answered by |
|---|---|
| *Is this the human who owns the vouching account?* | Same action ⇒ same nullifier ⇒ compare directly against the nullifier that account enrolled with |
| *Which vouch is this proof for?* | `signal = encodeVouchSignal(voucher, vouchee)` |

The identity check, from `app/src/app/api/vouch/attest/route.ts:160`:

```ts
const enrollmentNullifier = await getEnrollmentNullifier(voucher);  // read from the Enrolled event, live
if (enrollmentNullifier === null) return fail(409, "not_enrolled", …);
if (enrollmentNullifier !== presenceNullifier) {
  return fail(403, "nullifier_mismatch",
    "This presence proof was not generated by the same World ID that enrolled this account.");
}
```

That is the load-bearing line. Not "some verified human vouched" — *that* human, the one who holds
the World ID this account was enrolled with. A stolen session or a borrowed device with a different
World ID produces a different nullifier and is rejected.

The edge binding:

```ts
// app/src/lib/worldid-client.ts:30
export function encodeVouchSignal(voucher: string, vouchee: string): string {
  return `aval-vouch:${voucher.toLowerCase()}:${vouchee.toLowerCase()}`;
}
```

A proof generated for edge A→B has a different `signal_hash` than one for A→C, so it cannot be
replayed onto a different vouchee. Reusing the action costs nothing in privacy: the voucher's
nullifier is already known to Aval from enrollment, so re-deriving it reveals no new information, and
`signal` supplies all the per-vouch binding.

---

## 4. World App, MiniKit, and why the app is on chain 480

### MiniKit will not transact on any other chain

Aval was originally deployed to World Chain Sepolia (4801). Sign-in worked. Every transaction failed
with `invalid_operation`. The reason is in MiniKit's own source — `@worldcoin/minikit-js` **2.0.3**,
`build/index.cjs:733`:

```js
var WORLD_CHAIN_ID = 480;
…
function normalizeSendTransactionOptions(options) {
  const chainId = resolveChainId(options);
  if (chainId !== WORLD_CHAIN_ID) {
    throw new SendTransactionError("invalid_operation" /* InvalidOperation */, {
      reason: `World App only supports World Chain (chainId: ${WORLD_CHAIN_ID})`
    });
  }
```

The check is client-side, unconditional, and appears twice (again in `nativeSendTransaction`). MiniKit's
EIP-1193 provider also hardcodes the answer:

```js
// build/index.cjs:2170
case "eth_chainId":
  return "0x1e0";      // 480
```

No flag or config changes this. A Mini App user on testnet could sign in but could never enroll, vouch
or claim. The only fix was to redeploy the contracts to mainnet — which is also what made the *real*
Address Book reachable, and which is what surfaced E-18 below.

### World App wallets are smart contracts, so sign-in is not `ecrecover`

World App accounts are Safe smart accounts. Their `walletAuth` signatures are ERC-1271, not ECDSA
signatures over the message digest. An `ecrecover`-based check does not "fail to verify" them — it
recovers an unrelated address and confidently rejects a perfectly valid signature.

```ts
// app/src/lib/authSession.ts:175
export async function verifyWalletSignature(address, message, signature): Promise<boolean> {
  try {
    return await getVerificationClient().verifyMessage({ address, message, signature });
  } catch {
    return false;   // fails closed — an unreachable RPC never admits an unverified address
  }
}
```

viem's *public-client* `verifyMessage` (as opposed to the pure one) tries EOA recovery, then falls back
to an on-chain ERC-1271 `isValidSignature` call, and to ERC-6492 for accounts not yet deployed — which
matters because a World App user's account is counterfactual until their first transaction. That
fallback needs a chain to call, which is why this module holds its own `PublicClient`.

The sign-in flow itself is a server-issued, single-use, HMAC-signed nonce → real signature →
`/api/auth/verify` → httpOnly `aval_session` cookie. It replaced a build where a client-writable
`aval_addr` cookie *was* the identity (a forged cookie rendered another member's dashboard in
server-rendered HTML).

Two smaller World App facts the code had to learn the hard way, both documented inline in
`app/src/lib/session.tsx`:

- `MiniKit.isInstalled()` reads a per-class-object flag. With more than one copy of the module in the
  bundle, `install()` delegates to `window.MiniKit` and *your* imported class's flag never flips. The
  branch decision uses `window.WorldApp` (injected by the host) instead, and commands are issued
  through whichever MiniKit object is actually live (`activeMiniKit()`).
- `sendTransaction` resolves with a **UserOperation hash**, not a transaction hash, the moment the
  bundler accepts it. `worldscan.org/tx/<userOpHash>` does not resolve. The UI says so instead of
  rendering a dead link as on-chain evidence, and enrollment polls `/api/identity/{address}` until the
  `Enrolled` event is actually readable before triggering the ENS mint.

---

## 5. The three blockers that only appeared against the real thing

These are in `docs/99-errata.md`. Each was invisible to the test suite, and each has a general lesson.

A note on provenance: the *incident* reports below (what a user saw, what a route returned at the time)
come from the errata and cannot be re-run now that the bugs are fixed. Every *SDK quote and chain read*
below was re-verified against the installed packages and mainnet while writing this document — the
grep commands are in §8.

### E-17 — `RP_ID` was set to the app ID, and every server-side signal said "fine"

The Developer Portal issues an app ID (`app_…`) and a separate RP ID (`rp_…`). They look
interchangeable. With the app ID in the `RP_ID` slot:

| Check | Result |
|---|---|
| `GET /api/enroll/rp-context` | **200**, real 132-char ECDSA signature |
| `POST …/api/v4/verify/{id}` | **400 `validation_error`** — World answering about the request body, i.e. it recognised the RP |
| Server logs | nothing |
| `npm run typecheck` | clean |

The only component in the stack that knew was a WASM module in the browser.
`node_modules/@worldcoin/idkit-core/dist/index.js:1042` carries the contract in a doc comment:

> Returns an error if `rp_id` is not a valid RP ID (must start with `rp_`)

The widget threw `invalid_rp_id_format` and **never opened**, so the biometric step was never offered.
Lesson: the server owning a value does not mean the server validates it. Confirming `rp-context`
returned 200 tested the route, not the flow.

### E-18 — the Solidity interface named a function that does not exist on chain

`IAddressBook` declared `getIsUserVerified(address) returns (bool)`. Probed against the live Address
Book on chain 480:

```
addressVerifiedUntil(address)(uint256)  ->  1789813327          ✅
getIsUserVerified(address)(bool)        ->  execution reverted  ❌
isVerified(address)(bool)               ->  execution reverted  ❌
verifiedUntil(address)(uint256)         ->  execution reverted  ❌
```

So `isAnchor()` reverted for every address — and with it every read that touches the bottom of the
fixed point.

**Where the wrong name came from.** `getIsUserVerified` is real — it is MiniKit's *JavaScript helper*.
Its own source (`node_modules/@worldcoin/minikit-js/build/address-book.js:26`) shows it is a wrapper
that calls `addressVerifiedUntil` and compares against `Date.now()`. The helper name was ported into
Solidity as if it were the contract method.

**Why 58 passing contract tests did not catch it.** The Address Book exists on World Chain **mainnet
only** — which is exactly why `script/GenesisAnchorBook.sol` was written as a testnet stand-in. The
stand-in was written to match the interface. So was `test/mocks/MockAddressBook.sol`. Interface, mock,
stand-in and tests all agreed with each other and none of them agreed with the chain. *A mock shaped to
fit an assumption tests the assumption against itself.*

**The larger error hidden inside it:** the real contract returns an **expiry**, not a boolean, because
Orb verification lapses. A `bool` interface could not have represented that even with the right name —
it can say "was verified", never "is verified *now*". The one externally-grounded fact in the protocol
had the wrong *type*. Fixing it made a previously inexpressible test possible: the mock gained
`setVerifiedUntil`, so a test can warp past an expiry and assert anchor status drops.

Note also that the JS helper `catch`es and returns `false`. Solidity has no such catch — a wrong
function name is a revert, not a `false`.

### E-19 — `require_user_presence: true` is unsatisfiable with this credential

A real person completed a real Selfie Check and was told **`user_presence_failed`**. Vouching — the
operation the whole protocol exists to perform — could not be completed by anyone.

From `@worldcoin/idkit-core` 4.2.2, `dist/index.js:2362`:

```js
const userPresenceCompleted = getUserPresenceCompleted(responsePayload);
if (config.require_user_presence === true && !userPresenceCompleted) {
  this.complete({ success: false, error: "user_presence_failed" });
  return;
}
// dist/index.js:2610
function getUserPresenceCompleted(payload) {
  const p = payload;
  return p?.user_presence_completed === true || p?.proof_response?.user_presence_completed === true;
}
```

`user_presence_completed` is a World ID **4.0** field. Both flows use `selfieCheckLegacy()`, whose own
type declaration (`dist/index.d.ts:661`) states:

> This preset only returns World ID 3.0 proofs. Use it for compatibility with older IDKit versions.

A 3.0 payload has no such field, so the flag is `undefined`, so the guard fires **every time**. Not
flaky — impossible by construction. The face scan genuinely succeeded before IDKit discarded it.

The rule was written protocol-first and was right as intent: a vouch creates trust from nothing, so it
should be the one place the design spends friction. But it assumed a capability the chosen preset does
not have, and the two facts lived in different documents, so neither review caught the contradiction.

**The first fix was also wrong, which is the more interesting half.** It kept a three-state server
check: accept `true`, accept `undefined` (legacy proof), still refuse an explicit `false` — reasoning
that `false` must mean "presence was attempted and failed". It does not. The client now sends
`require_user_presence: false`, so World App never runs a presence check and reports `false` to mean
**"not requested"**. Vouching failed again, this time with a message that was simply untrue. `false`
and `undefined` are indistinguishable here. **A server gating on a field whose value it determined by
not requesting it can only produce false negatives.** The check was removed, not re-tuned.

Restoring liveness properly requires moving **both** flows to a 4.0 preset (`proofOfHuman()`). It
cannot be done for vouching alone: 3.0 and 4.0 produce different nullifiers, so a 4.0 vouch proof would
no longer be comparable to a 3.0 enrollment nullifier — breaking the stronger property (§3) to buy the
weaker one.

---

## 6. What is live right now

World Chain mainnet, chain ID 480. Read at block 32,837,137.

### Contracts

| Contract | Address | Runtime bytecode |
|---|---|---|
| AvalRegistry | `0x6fEfEf2d44203300a6a33d631840C972181b8722` | 7,645 bytes |
| AvalToken | `0xdF0cdF53981bdbcCF25cC0d51E8948579adA82Ef` | 2,137 |
| CredibilityVault | `0xE3bb69E90d124268A348A3ef17420d05CF6e177D` | 7,199 |
| PlatformRegistry | `0xbBEE544679F9C5a8784F30195a9030131f9E9106` | 7,692 |
| ReportRegistry | `0x4570B517C75A90F85c9FeD321113fB80FC777bcC` | 9,938 |
| PresenceDrip | `0x4C0cf0D239A1012D432EDEa47e3BB1cb00F5192d` | 5,444 |
| *World ID Address Book* (not ours) | `0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D` | 3,095 |

`AvalRegistry` deployed at block **32833177**, tx
`0x8636e08a48a01c5b6a4c200fb7a7039fc11764870ef5830925e762337d712384`. Wiring read back live:

```
addressBook()                                  0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D
governor()                                     0x87Ee33B2B9D46E0ACEab852550bDB891A3403864
attestors(0x69827C0FEF274C63Ac4806106F2BA544E6129050)   true
```

### Anchor resolution, post-E-18

```
addressVerifiedUntil(0xB23a3B23…2B47) = 1789813327   (2026-09-19T10:22:07Z)
addressVerifiedUntil(0x4774b962…e7de) = 1796790737   (2026-12-09T04:32:17Z)
addressVerifiedUntil(0x0000…dEaD)     = 0

AvalRegistry.isAnchor(0xB23a3B23…2B47) = true
AvalRegistry.isAnchor(0x4774b962…e7de) = true
AvalRegistry.isAnchor(0x0000…dEaD)     = false
```

Both live members are genuinely Orb-verified humans, resolved through World ID's own contract.

### The complete on-chain history of the registry

Seven events, ever. Two from the constructor (`GovernorTransferred`, `AttestorSet` at block 32833177),
two wiring setters (`ReportRegistrySet` at 32833184, `PlatformRegistrySet` at 32833186), then:

**Enrollment 1 — `philoo.aval.eth`**
```
account      0xB23a3B2384D721d7C487a3ACc6405a1d36672B47
tx           0xde6f732eeb3c812d81df6098f74eab48b7c76f40f9443832299e13255fd52749
block        32833568   (2026-07-25T18:06:15Z)
nullifier    0x26337196de3621e1c27b3a0cd5ed290404ac490b1ad2074274928f59e2b9092f
credential   0x429ce4cb…4e06 = keccak256("selfie-check")
expires      1792778775 (2026-10-23T18:06:15Z, +90d)
```

**Enrollment 2 — `romariokavin.aval.eth`**
```
account      0x4774b9621102eAc2254365f9311C4E7700D9e7de
tx           0xcbafd84a98bc5e8f2eb7e5a660cfaf57220a344fb5fdc8164a289bed239869f4
block        32833881   (2026-07-25T18:16:41Z)
nullifier    0x083e09bff054d1b2ec02f48990da0347a522ae3ca412f6ef734ef2609e6f535d
credential   keccak256("selfie-check")
```

Both nullifiers read back `usedNullifier(...) == true`, so a second wallet using either World ID
reverts `NullifierUsed`.

**Vouch — philoo → romariokavin**
```
tx           0x563172cb968bb63b2ba362fa95d6ff257bf94554076ebbbb39e3969cab3d5c45
block        32835377
issuedAt     1785006393 (2026-07-25T19:06:33Z)
expiresAt    1792782393 (2026-10-23T19:06:33Z, +90d)
isActiveVoucher(philoo, romariokavin) = true
```

No `Revoked`, `Swept`, `Reaffirmed`, `CredentialRenewed` or `FraudConfirmed` events exist. That is the
entire mainnet history — nothing is hidden behind a curated view.

### These really came from World App

All three transactions were sent to the canonical ERC-4337 EntryPoint v0.7
(`0x0000000071727De22E5E9d8BAf0edAc6f37da032`) by three different bundler EOAs. Both member addresses
are 171-byte proxies whose slot 0 points at Safe singleton
`0x29fcB43b46531BcA003ddC8FCB67FFE91900C762` — i.e. World App smart accounts, not EOAs pretending to
be users. This is also the direct on-chain reason §4's ERC-1271/6492 sign-in path is required.

---

## 7. Honest limitations

**1. On this deployment, vouching for an Orb-verified human does nothing.** This is the big one, and it
contradicts the product's own tagline ("proof of human is a floor — this is the ladder"). An anchor's
score is fixed at 100 and ignores all inbound edges (errata E-6, `engine/src/score.ts:535`). Both live
members are anchors. Running the real engine on the exact live graph:

```
with vouch   : {romariokavin: 10000, philoo: 10000}   tiers {2, 2}
without vouch: {romariokavin: 10000, philoo: 10000}   tiers {2, 2}
```

Identical. For contrast, the same graph with the vouchee *not* Orb-verified:

```
B not anchor : {romariokavin: 4000, philoo: 10000}    tiers {0, 2}
```

40.00 = base 20.00 + one anchor vouch capped at 20.00, still short of Tier 1 (55.00). That is the
product working — but no non-anchor human has enrolled on mainnet, so the ladder itself is not
demonstrated on chain 480. The full demonstration, including a 6-account collusion ring being correctly
denied, lives on World Chain Sepolia (`deployments/worldchain-sepolia.json`) where a stand-in anchor
book allowed non-anchor accounts to exist. The mainnet deployment is honest about this in its own
`noSeededGraph` field.

**2. Liveness is not enforced.** `require_user_presence` is `false` in both widgets and there is no
server-side presence gate at all (E-19). The account-rental and slot-farming attacks that presence was
supposed to price are currently priced only by the 1-vouch-per-24h rate limit and the 3/10-slot cap.
The vouch UI states this on the step itself rather than advertising a guarantee that does not hold.

**3. The chain trusts the attestor for everything World ID.** `AvalRegistry.vouch()` takes **no
nullifier and no proof** — only an EIP-712 signature from an allowlisted attestor. All World ID
checking (nullifier equality, signal binding, tier) happens off-chain in `/api/vouch/attest`. The
attestor is a single EOA (`0x69827C0FEF274C63Ac4806106F2BA544E6129050`) whose key lives in the app's
environment. Compromise it and you can mint enrollments and vouches with no World ID involvement
whatsoever. `enroll()` is slightly better — `usedNullifier` is at least recorded on chain, so
double-enrollment stays publicly auditable — but the *provenance* of a nullifier is not verified
on chain either. Governor is likewise a single EOA and equals the deployer; the deployment file itself
notes a real deployment would make it a 2-of-3 multisig.

**4. The signal-binding check is conditional on the field being present.** Both routes do
`if (r.signal_hash && r.signal_hash.toLowerCase() !== expected)`. A response object with no
`signal_hash` skips the local comparison, leaving edge/wallet binding to World's verify endpoint alone.
It should assert presence, not just consistency.

**5. Credential expiry is enforced but unrenewable in the app.** `credentialExpiresAt` is 90 days,
`GRACE_PERIOD` 14 days, and `_suspended()` blocks vouching past that. `renewCredential()` exists on the
contract and **has no UI** — `renewCredential` appears nowhere in `app/src`. In 104 days both live
members stop being able to vouch with no in-app way to fix it.

**6. `docs/03-worldid.md` §3.1 has drifted from the code.** It justifies anchors being Tier 2 with
"score 100 ≥ T2". After errata E-16 raised the base score, `T2 = 14_000` (140.00), so 100 is *below* it.
Anchors are still Tier 2 — but because `score.ts` puts them in `originsSet` and assigns tier 2 by
construction, not for the reason the doc gives. The behaviour is right; the doc's reasoning is stale.

**7. Minor recording errors in `deployments/worldchain-mainnet.json`.** It lists AvalRegistry's runtime
size as 7,637 bytes; the live contract is 7,645 (7,637 is the *superseded* pre-E-18 registry at
`0x7a294C7C…`, still on chain, marked dead). It also records `deployedAtBlock: 32833180`, while the
registry's own constructor events are in block 32833177. Both are bookkeeping slips in a file that is
otherwise accurate, and they are the kind of thing worth catching before a judge does.

**8. Two humans is two humans.** One vouch, zero revocations, zero reports on mainnet. The trust math,
the collusion resistance and the report/slashing paths are exercised by 60 engine tests and 58 contract
tests, and on Sepolia — not by mainnet traffic.

---

## 8. Verify it yourself

```bash
RPC=https://worldchain-mainnet.g.alchemy.com/public
REG=0x6fEfEf2d44203300a6a33d631840C972181b8722
AB=0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D

# The registry is wired to World ID's real Address Book
cast call $REG "addressBook()(address)" --rpc-url $RPC

# E-18: the function the interface used to declare does not exist
cast call $AB "addressVerifiedUntil(address)(uint256)" \
  0xB23a3B2384D721d7C487a3ACc6405a1d36672B47 --rpc-url $RPC   # -> 1789813327
cast call $AB "getIsUserVerified(address)(bool)" \
  0xB23a3B2384D721d7C487a3ACc6405a1d36672B47 --rpc-url $RPC   # -> execution reverted

# Anchor status resolves through the real Orb registry
cast call $REG "isAnchor(address)(bool)" 0xB23a3B2384D721d7C487a3ACc6405a1d36672B47 --rpc-url $RPC
cast call $REG "isAnchor(address)(bool)" 0x000000000000000000000000000000000000dEaD --rpc-url $RPC

# One account per World ID, on chain
cast call $REG "usedNullifier(uint256)(bool)" \
  0x26337196de3621e1c27b3a0cd5ed290404ac490b1ad2074274928f59e2b9092f --rpc-url $RPC

# The live vouch
cast call $REG "isActiveVoucher(address,address)(bool)" \
  0xB23a3B2384D721d7C487a3ACc6405a1d36672B47 \
  0x4774b9621102eAc2254365f9311C4E7700D9e7de --rpc-url $RPC

# Full event history (this public RPC caps eth_getLogs at 100 blocks; loop from 32833177)
cast logs --from-block 32835300 --to-block 32835399 --address $REG --rpc-url $RPC
```

And in the repo, without running anything:

```bash
grep -n "WORLD_CHAIN_ID = 480" -A 8 node_modules/@worldcoin/minikit-js/build/index.cjs
grep -n "user_presence_failed" -B 4 node_modules/@worldcoin/idkit-core/dist/index.js
grep -n "only returns World ID 3.0 proofs" node_modules/@worldcoin/idkit-core/dist/index.d.ts
grep -n "addressVerifiedUntil" node_modules/@worldcoin/minikit-js/build/address-book.js
```
