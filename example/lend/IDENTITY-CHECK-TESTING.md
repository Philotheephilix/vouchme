# Identity Check (Identity Attestations) — testing report

**Project:** Lend — micro-loans in WLD, gated on VouchMe standing.
**Track:** Identity Check beta test.
**SDK under test:** `@worldcoin/idkit-core@4.2.2`.
**App:** `app_6876091cf45989753582a3595b9b8167` (LendMe), RP `rp_b13792fb4ff6f738`, managed registration.
**Date of testing:** 26 July 2026.

---

## Read this first

Identity Check is preview-gated and **is not enabled for this app id**. No real attestation was
completed, by us or by anyone, during this work. Everything below is either

- something we ran and can show you the output of, or
- something we could not run, said plainly, with what blocked it.

Nothing here fabricates a successful attestation. There is no screenshot of a green tick, no
invented user quote, and no drop-off percentage. Section 2 is labelled analytical because it is
analytical.

The feature was still built to completion and the server boundary is closed and tested. That is the
point of the exercise: a gate you cannot open should still be a gate you can prove is shut.

### What is proven, and what is not

| | Status | Evidence |
|---|---|---|
| Attribute policy, per pool | Built and tested | `npm run test:identity` |
| Attributes actually put on the wire | Proven | `npm run test:probe` |
| Consent screen and copy | Built | `src/components/IdentityCheck.tsx` |
| Server refuses unsigned / forged / replayed / unbound requests | Proven | `npm run test:identity`, 31/31 |
| Client-asserted `identity_attested: true` is ignored | Proven | `npm run test:identity` |
| Jurisdiction policy enforced server-side | Proven | `npm run test:identity` |
| The allow branch executes when a verifier attests | Proven, **against a local stub verifier** | `npm run test:identity` |
| World App renders our consent screen | **Not verified** — no entitlement, no device |
| World App produces `identity_attested: true` | **Not verified** — no entitlement |
| World's verify endpoint returns `identity_attested` | **Not verified, and we doubt it — see D1** |
| Real drop-off, comprehension, or user sentiment | **Not observed** — no users were run |

---

# 1. Developer feedback

Ordered by how much time each one cost, worst first. Every claim has a command you can run.

## D1 — There is no documented way for a backend to learn that an attestation happened

**This is the finding that matters.** Everything else on this list is friction; this one is a hole.

`identity_attested` appears in exactly one place in the SDK: on the client-side result envelope.

```
node_modules/@worldcoin/idkit-core/dist/index.d.ts:194
    /** Whether identity attributes were attested. Only present on IdentityCheck responses. */
    identity_attested?: boolean;
```

That object arrives in the browser. A browser can write it. So it cannot be the basis of a decision
that unlocks money, and the docs correctly tell integrators to verify proofs server-side against
`POST https://developer.world.org/api/v4/verify/{rp_id}`.

The problem: **the published response schema for that endpoint does not include `identity_attested`,
and its request schema has no field for the attributes you asked about.** The documented response is
`success`, `action`, `nullifier`, `created_at`, `environment`, `session_id`, `results[]`, `message` —
and `results[]` is `identifier`, `success`, `nullifier`, `code`, `detail`.

We probed the live endpoint. It accepts a v4 body carrying an unknown top-level `identity_attested`
without complaint, verifies the proof on chain, and answers without ever mentioning attestation:

```console
$ curl -sS -X POST https://developer.world.org/api/v4/verify/rp_174c6e008c2a86e2 \
    -H 'content-type: application/json' \
    -d '{"protocol_version":"4.0","nonce":"0x…01","action":"identity-check-probe",
         "identity_attested":true,
         "responses":[{"identifier":"passport","proof":["0x01","0x02","0x03","0x04","0x05"],
                       "nullifier":"0x01","issuer_schema_id":9303,"expires_at_min":1}]}'

{"success":false,"code":"all_verifications_failed","detail":"All proof verifications failed.",
 "results":[{"identifier":"passport","success":false,"code":"verification_failed",
             "detail":"execution reverted (unknown custom error)"}]}
HTTP 400
```

(The proof is nonsense, so the on-chain check failing is expected and correct. What matters is the
shape of the reply, and that our injected `identity_attested` was neither rejected nor echoed.)

Nor is the attribute predicate visibly carried in the proof: `ResponseItemV4.proof` is documented as
"first 4 elements are compressed Groth16 proof, 5th is Merkle root", with no slot for attribute
public inputs, and the verify request has nowhere to state which attributes you asked about — so the
endpoint could not re-check the match even in principle.

We could not resolve this from the docs. `docs.world.org/world-id/id/identity-check` and
`/identity-attestations` both 404. The IDKit integration page does not mention Identity Check at all.
The protocol spec lists age attestation under "Future Proofing Notes".

**Consequence for an integrator:** you are pushed toward exactly the insecure thing the rest of the
documentation warns against — trusting a client field — because no server-side alternative is
documented. We refused to do that, so **Lend's gate can never open against the real endpoint today**,
by construction:

```ts
// src/app/api/identity/route.ts
if (verify.identity_attested !== true) { /* refuse */ }
```

`verify` is World's reply, not the request body. Today that field is absent, so this always refuses.
We consider that correct rather than a bug to work around.

**Ask of World:** publish `identity_attested` (and ideally the matched attribute list) on the v4
verify response, or document the intended server-side verification path. Until then no
Identity-Check-gated product can be built safely.

## D2 — `idkit-core` cannot run under Node at all

Any builder call in a Node process dies before it does anything:

```console
$ node -e "…IDKit.request({…}).preset(identityCheck({…}))"
ERROR TEXT: Failed to initialize IDKit WASM: TypeError: fetch failed
```

Cause:

```
node_modules/@worldcoin/idkit-core/dist/index.js:2208
    module_or_path = new URL("idkit_wasm_bg.wasm", import.meta.url);
…:2213   module_or_path = fetch(module_or_path);
…:2234   throw new Error(`Failed to initialize IDKit WASM: ${error}`);
```

Under Node that URL is `file://`, and Node's `fetch` does not implement `file://`. `initIDKit()`
takes no argument, and neither `initSync` nor any init-from-bytes entry point is exported from the
package, so there is no supported escape hatch.

**Cost:** the message names neither the URL nor the scheme, so it reads as a network outage. We lost
time checking egress before reading the dist.

**Workaround**, used in `test/probe-idkit.mjs` so the wire-format claims below are reproducible:
shim `globalThis.fetch` to serve `file://` from disk. Fine for a probe; not something to ship.

**Ask of World:** export `initSync`, or accept a path/bytes argument on `initIDKit`, or fall back to
`readFile` when `import.meta.url` is `file://`. Failing all that, put the URL in the error.

## D3 — `legacy_signal` is misnamed; the documented `signal` is a partial trap

We were told a developer copying the documented `signal` gets no type error. **That is half right,
and the half matters.** Written as a direct object literal, TypeScript catches it — verified by
compiling a scratch file under this project's `tsconfig.json`:

```
error TS2353: Object literal may only specify known properties,
and 'signal' does not exist in type '{ attributes: IdentityAttribute[]; legacy_signal?: string | undefined; }'.
```

Spread from an options object — how anyone with more than one call site writes it — it compiles
silently:

```ts
const opts = { attributes: [...], signal: "user-123" };
identityCheck({ ...opts });   // no error; `signal` is dropped on the floor
```

`identityCheck` reads only `params.legacy_signal` (`dist/index.js:2746`), so the signal vanishes and
the wire carries `hashSignal("")` — an unbound proof, from a developer who followed the docs. Excess
property checking is the only thing standing between them and that, and it does not survive a
spread.

Meanwhile the name is actively misleading. `legacy_signal` is **not** legacy-only. `npm run
test:probe`:

```
legacy (top-level) signal: 0x0025fc936849489166e0250134c13551de48748e23cf44c2eb4f2e26f1e2dcb6
hashSignal(legacy_signal) : 0x0025fc936849489166e0250134c13551de48748e23cf44c2eb4f2e26f1e2dcb6
v4 proof_requests[].signal: ["0x6c656e642d6964656e746974793a30786162633a6465616462656566", …]
```

The last value is the hex of the UTF-8 bytes of the signal string, sitting on the **v4** credential
requests. So the only parameter named as if it were vestigial is in fact the one and only way to
bind an Identity Check proof to a session — and its name tells you not to use it.

Note the two encodings: the legacy top-level field is `hashSignal(s)`, the v4 field is raw hex. Which
convention `ResponseItemV4.signal_hash` comes back in is undocumented, and we could not test it. That
is flagged in the code at `src/app/api/identity/route.ts` (step 4) as the one unverifiable assumption
in this integration, with both values logged on mismatch so it is a one-minute diagnosis.

**Ask of World:** rename to `signal`, or document that `legacy_signal` binds v4 proofs too. Today the
docs' `signal` and the SDK's `legacy_signal` are different names for overlapping things.

## D4 — `allow_legacy_proofs: false` is ignored for every v4 preset

The field is mandatory and its own doc comment is explicit:

```
index.d.ts:59      allow_legacy_proofs: boolean;
              /** - `false`: Only accept v4 proofs. Use after migration cutoff or for new apps. */
```

The JS forwards it faithfully (`index.js:2775`, `config.allow_legacy_proofs ?? false`). The wire
payload disagrees. `npm run test:probe`:

```
identityCheck  config=false -> wire allow_legacy_proofs=true
identityCheck  config=true  -> wire allow_legacy_proofs=true
proofOfHuman   config=false -> wire allow_legacy_proofs=true
proofOfHuman   config=true  -> wire allow_legacy_proofs=true
orbLegacy      config=false -> wire allow_legacy_proofs=false
orbLegacy      config=true  -> wire allow_legacy_proofs=true
```

Legacy presets honour it. **v4 presets, including `identityCheck`, always send `true`.**

**Why it matters here specifically:** a World ID 3.0 result cannot carry `identity_attested` at all
(`IDKitResultV3` has no such field). So an integrator who asked for v4-only, and got a v3 proof
anyway, has a proof of something they did not ask about — and if their server treats "verified" as
"attested", they have just opened a gate on a document check that never happened.

Lend does not rely on the flag. `src/app/api/identity/route.ts` rejects any result whose
`protocol_version` is not `"4.0"`, which is asserted by test:

```
PASS  a legacy 3.0 result is refused — it cannot carry an attestation  — 400 wrong_protocol
```

## D5 — Preview gating gives no early signal, and no error we could capture

We expected an entitlement error somewhere. There is none we could reach.

- `POST /api/v4/proof-context/{rp_id}` returns app display metadata (200) and **silently ignores**
  an `identity_attributes` array posted to it.
- `GET /api/v4/rp-status/{rp_id}` returns `{"production_status":"registered","staging_status":"registered"}`
  — no mention of Identity Check either way.
- Building a real Identity Check request against the live bridge **succeeds**, returns a
  `connectorURI`, and polls to `{"type":"waiting_for_connection"}`. No entitlement check at request
  creation.

So a developer without entitlement gets a working QR code and a request that never completes.
Whatever failure exists happens on the device, after the user has already engaged — which is also a
user-facing problem (see U6). We could not capture the device-side error: it requires World App and
an enabled app id, and we have neither.

The one entitlement-ish string we found is in the WASM binary, not triggered by us:

```
IdentityCheck presets are not supported for nativePayloadV1FromPreset.
Use nativePayloadFromPreset with a World ID 4.0-compatible client instead.
```

That is a World App *version* gate (verify v1 vs v2) rather than a preview gate. It reaches users on
older World App builds and is worth surfacing as its own message; we map the related
`world_id_4_not_available` code to "Update World App and try again".

**Ask of World:** expose entitlement on `rp-status`, and fail request creation with a named error
when an app id lacks it. Discovering this on the user's device is the most expensive possible place.

## D6 — The attribute list travels outside the RP signature

From the decrypted request payload (`npm run test:probe`):

```
identity_attributes is a SIBLING of proof_request, i.e. OUTSIDE the RP signature: true
proof_request signature covers: action, constraints, created_at, expires_at, id, nonce,
  oprf_key_id, proof_requests, proof_type, rp_id, session_id, signature, version
```

The relying party's ECDSA signature covers `proof_request`. `identity_attributes` sits next to it,
unsigned. We have not established what this permits — the transport is end-to-end encrypted to the
bridge, so this is not trivially attacker-controlled — but "the thing being consented to is outside
the signature over the request" is worth an explicit answer from World, because the user's consent
screen is presumably rendered from it.

## D7 — An empty attribute list is accepted everywhere

```
attributes: []  ->  wire identity_attributes: [] (no error, no warning)
```

No type error, no runtime error, no warning. An integrator who builds the array conditionally and
lands on `[]` sends an Identity Check that asks nothing — and, presumably, attests trivially. The
failure is silent and points the wrong way: the flow *succeeds*.

Lend cannot hit this: `attributesFor()` in `src/lib/identity.ts` always emits `minimum_age`, and
throws rather than returning an empty list for an unserved jurisdiction. But that is our discipline,
not the SDK's.

## D8 — Identity Check silently requires a document credential

Not documented anywhere we found; visible only in the wire payload:

```
credential constraints: {"any":["passport","mnc"]}
```

`identityCheck` resolves to passport **or** mobile network credential. An Orb-verified user with no
document in World App cannot complete it. That is a legitimate design, but an integrator reading
"identity attributes beyond simple proof of human" will not guess that their entire Orb-verified user
base is ineligible, and will size the funnel wrongly.

We surface it in the consent screen before the user commits ("You will need a passport, national
eID, or mobile network ID already added to World App") and map `credential_unavailable` to an
actionable message. Both are guesses at good behaviour that we could not validate against a real
device.

## D9 — Smaller things that still cost time

- **Two different `Status` types** are exported from one `.d.ts`: a discriminated union
  (`Status$1`, exported as `Status`) and an `interface Status` with optional `result`/`error`. The
  narrowing behaviour differs and the compiler picks the one you did not mean.
- **`environment` is `string` on results** but `"production" | "staging" | "sandbox"` on config
  (`index.d.ts` — `IDKitRequestConfig.environment` vs `IDKitResultV4.environment`). A staging
  attestation unlocking a real payout is a serious bug, and the loose type removes the compiler's
  help. Lend stores it and returns it on every response.
- **Managed RP keys.** Our registration is `mode: "managed"` — World holds the signing key in KMS,
  and the Developer Portal returns a private key **only on generation or rotation**. There is no
  "show me the key" path. So standing up `rp_context` signing on an existing managed app means
  rotating, which re-registers on chain. We declined to rotate a live registration for a test, and
  Lend therefore fails closed on missing credentials — which is itself asserted:
  ```
  PASS  a served jurisdiction reaches the config wall and fails CLOSED, naming what is missing
        — 503 identity_unavailable — Identity Check is not configured on this server
          (missing LEND_WORLDID_RP_ID, LEND_WORLDID_ACTION, LEND_WORLDID_SIGNING_KEY).
  ```
- **`rp_context` was the one thing that was easy.** `signRequest` from
  `@worldcoin/idkit-core/signing` is pure JS, needs no WASM, and works in a Next route handler
  first try. Worth saying, since the rest of this list is complaints.

---

# 2. User feedback

> ## ⚠ THIS SECTION IS ANALYTICAL, NOT OBSERVED.
>
> **No user sessions were run. No users were recruited, watched, surveyed or interviewed.** Identity
> Check is not enabled for this app id, so the flow cannot be completed by anyone, and putting people
> through a flow that always fails would measure our error handling, not their comprehension.
>
> What follows is: (a) a walkthrough of the screens as built, naming where we believe comprehension
> or consent can break and why; (b) the consent copy we wrote and the reasoning behind each line;
> (c) every failure state and its user-visible result; (d) a test protocol someone can run once
> entitlement lands. The predictions in (d) are predictions. They are labelled as such.

## 2.1 The flow, screen by screen

### Screen 1 — the pool list

Each pool shows both requirements before anything is tapped:

```
Starter    0.05 WLD    TIER 1 · ID 18+
Standard   0.10 WLD    TIER 2 · ID 18+, LICENSED COUNTRY
Prime      0.20 WLD    SCORE 105+ · ID 18+, LICENSED COUNTRY
```

*Why up front:* a person who cannot meet the age or country rule should learn it from the list, not
after opening their passport. Late disclosure is the most expensive kind.

**Where comprehension can break**

- **"ID 18+" is compressed to the point of ambiguity.** It could read as "you must be 18", "you must
  have ID", or "you must have had ID since you were 18". We chose brevity because it is a chip on a
  phone-width card. *Unresolved. This is the line we would test first.*
- **"Licensed country" does not say whose country.** It means the country that issued your document.
  A user might read it as where they live, or where Lend is. The next screen says it explicitly, but
  the list does not.
- **Two requirements, two different remedies, one visual treatment.** Tier and ID render in the same
  grey uppercase. A locked pool shows one chip — the *standing* one if standing fails, because we
  refuse to send someone through a document check they will pass only to stay locked. Correct
  behaviour, but the user sees only one of two walls and may fix it and still be stuck.

### Screen 2 — jurisdiction (only for Standard and Prime)

> Where was your ID issued? This pool is only offered in some countries.
>
> `[Portugal] [Spain] [France] [Germany] [Netherlands] [Ireland]`
>
> Not listed? Lend is not licensed to offer this pool where your ID was issued. The Starter pool does
> not ask this.

*Why we ask instead of tell:* Identity Check is an **assertion-matching** API. Every
`IdentityAttribute` carries a `value` you supply; you learn whether it matched, never what the value
is. So "is this person in one of six countries" cannot be asked in one request, and "is this person
*not* in a blocked country" cannot be asked at all. Asking the user to declare, refusing the unserved
list locally, and then attesting the declaration is the honest shape of the primitive. It also leaks
less: we only ever ask World about the one country the user already told us.

**Where consent can break**

- **The user cannot tell that declaring is not disclosing.** Tapping "Portugal" feels like handing
  over a fact. It is not — it stays on our server unless and until they consent on the next screen.
  We do not currently say so. *A gap we would fix after testing, not before: the fix is another
  sentence, and another sentence on a consent flow is not free.*
- **A person in an unserved country is told no by a list they must read themselves.** There is no
  "my country isn't here" button. They have to notice an absence. Absences are hard to notice.
- **The fallback is buried in the last line.** "The Starter pool does not ask this" is the single
  most useful sentence on the screen for anyone who fails it, and it is in the smallest type.

### Screen 3 — consent

This is the screen the whole feature exists for. Verbatim, for Prime with Portugal declared:

> World App will answer yes or no to 2 questions about your ID. Lend receives the answer, never the
> document.
>
> ✓ that you are 18 or older
> ✓ that your ID was issued by Portugal
>
> Not shared with Lend: your name, your ID number, your date of birth, your photo, your address.
>
> You will need a passport, national eID, or mobile network ID already added to World App.
>
> `[ Share these answers ]`
> `[ Not now ]`

**Line-by-line reasoning**

| Line | Why it is there |
|---|---|
| "answer yes or no to 2 questions" | Names the *shape* of the disclosure, not just its subject. "We verify your age" leaves open whether a birthdate was handed over. "Yes or no" does not. |
| "Lend receives the answer, never the document" | The single sentence a person needs to distinguish this from uploading a passport photo, which is what most people have been trained to expect. |
| One ✓ per claim, one per line | So the claims can be **counted**. Prose lets a third claim hide in a subordinate clause. |
| "that you are 18 or older" | Not "your age". We learn a predicate, and the copy says a predicate. |
| "that your ID was issued by Portugal" | Names the country the user chose, so a mis-tap on the previous screen is visible here and can be corrected. |
| **"Not shared with Lend: …"** | The half integrations omit. A user cannot inspect the payload, so an unstated absence is unverifiable. We enumerate rather than say "nothing else", because "nothing else" is a promise a reader has no reason to believe and a list is checkable against their intuition. |
| "You will need a passport, national eID…" | D8: `identityCheck` resolves to `{"any":["passport","mnc"]}`. Discovering that inside World App, mid-flow, is the worst place to discover it. |
| "Not now" as a real button | A consent screen whose only affordance is consent is not a consent screen. |

The list is generated from the same policy object that builds the wire payload
(`consentCopy()` and `attributesFor()`, both in `src/lib/identity.ts`), so copy and payload cannot
drift apart. If someone adds an attribute and forgets the copy, the copy changes with it.

**Where consent can still break**

- **"Not shared with Lend" is scoped to Lend, and users may not scope it that way.** World App does
  see the document. We think this wording is honest and the distinction is real, but "not shared"
  followed by "with Lend" is exactly the kind of qualifier a reader drops.
- **Nothing states retention.** We store a boolean, a country code, and a nullifier for 30 days. The
  screen does not say that. A careful person cannot find out how long this lasts.
- **"2 questions" is our count, unverifiable by the user.** They are trusting the number. That is
  intrinsic to the medium and is the strongest argument for World App showing the attribute list
  itself on its own consent screen — which we could not verify that it does (D5).
- **Nobody knows what happens on "no".** If the ID says 17, the copy does not say whether Lend
  learns the real age (it does not) or how long the refusal lasts.

### Screen 4 — World App

Out of our hands, and unverified. Inside World App the native transport is used; outside, an
"Open World App" link on the connector URI. We do not know what World App shows for an Identity Check
consent, whether it lists the attributes, or whether it distinguishes them from a plain proof of
human. **This is the largest unknown in the user journey and it is the part the user will trust
most.**

### Screen 5 — the result

Success: `Identity verified. This pool is open.` and the pool re-renders with a Claim button. The
attestation persists for 30 days, so a returning user is not asked again — re-attestation on every
page load would be both hostile and, given a document scan, absurd.

## 2.2 Every failure state and what the user sees

| Failure | Code | What the user sees |
|---|---|---|
| User declines in World App | `user_rejected` | "You cancelled the check. Nothing was shared." |
| User backs out on our consent screen | — | Returns to the pool list. No request made. |
| No document in World App | `credential_unavailable` | "World App has no ID document on this account. Add a passport or national eID in World App, then try again." |
| Attributes do not match (under 18, wrong country) | `identity_attributes_not_matched` | "Your ID does not match what this pool requires." |
| Presence check failed | `user_presence_failed` | "World App could not confirm you were present. Try again." |
| World App too old for v4 | `world_id_4_not_available` | "This version of World App does not support identity checks. Update World App and try again." |
| RP unknown or inactive | `unknown_rp` / `inactive_rp` | "Lend is not registered for identity checks yet. This is our problem, not yours." |
| Timed out | `timeout` | "The check timed out. Nothing was shared." |
| Jurisdiction not served | `jurisdiction_unavailable` (403) | "Lend is not licensed to offer Prime in USA." — **before any document is opened** |
| **Preview not enabled** | `not_attested` / `attestation_absent` (403) | "World ID verified your proof but did not return an identity attestation. Lend cannot open this pool without one. Identity Check is in preview and may not be enabled for this app yet." |
| Server not configured | `identity_unavailable` (503) | Names the missing variables. Pool stays shut. |
| World unreachable | `worldid_unreachable` (502) | Denies, and says the verifier could not be reached rather than implying the user failed. |
| Same document, second account | `nullifier_reused` (409) | "This ID has already been used to verify a different Lend account." |

Two deliberate distinctions:

1. **"Your ID did not match" vs "we did not get an attestation".** The first is about the person, the
   second is about us. Collapsing them tells a 25-year-old that their ID says they are under 18.
2. **"Nothing was shared" is stated on cancel and on timeout.** After tapping through a document
   flow, a user has no way to know whether the abort happened before or after disclosure.

## 2.3 Test protocol — to run once entitlement lands

**Not yet run.** Written so it can be handed to someone as-is.

**Participants.** 12–15, quota'd on: has completed World ID document verification / has not; is in a
served jurisdiction / is not; age 18–24 / 25+. At least three who have never used a mini app.

**Setup.** Real device, real World App, entitlement enabled, treasury funded with test WLD. Screen
and audio recording. Moderator does not explain the product.

**Tasks.**

1. "Borrow the largest amount you can." *(Do they find the ID requirement? Do they read the list, or
   tap and discover?)*
2. Immediately after the consent screen appears, before they tap: **"Tell me what Lend is about to
   learn about you, and what it will not."** *(The comprehension measure. Free recall, unprompted.)*
3. Complete the check.
4. "Come back tomorrow and borrow again." *(Does the 30-day persistence read as convenient, or as
   "why didn't it ask?")*
5. For unserved-jurisdiction participants: "Borrow from Prime." *(Do they understand the refusal is
   about licensing, not about them?)*

**Measures.**

- **Comprehension (primary).** Task 2, scored blind against the actual payload: does the participant
  name age? country? Do they wrongly name name / ID number / photo / address? Report per-item hit
  rate, not a single score — a person who knows their name is safe but thinks their birthdate went is
  a specific, fixable failure.
- **Consent quality.** Time on the consent screen; whether they scroll to the "Not shared" line
  before tapping (eye tracking or scroll telemetry); whether anyone taps "Not now" and why.
- **Drop-off, per step.** Pool list → jurisdiction → consent → World App → result.
- **Failure recovery.** For `credential_unavailable`, do they successfully add a document and return?
- **Trust delta.** Single item before and after: "How comfortable are you giving this app ID
  information?" 1–7.

**Where we predict drop-off, and why.**

| Step | Prediction | Reasoning |
|---|---|---|
| Consent → World App | **Largest single drop.** | A handoff to another surface, for a document scan, for 0.10 WLD. The value on offer is small relative to the perceived ask. |
| World App → result | Second largest. | D8: `{"any":["passport","mnc"]}`. Anyone Orb-only fails here, and they fail *after* consenting — the most expensive place to fail. |
| Jurisdiction screen | Moderate, concentrated. | Everyone outside six countries stops. Not a UX failure, but it will look like one in the funnel unless segmented. |
| Pool list → consent | Small. | The requirement is visible before the tap, so most self-selection happens here — which is the intent. |

**What would change our design.** If task 2 shows participants believing their name or document
number is shared, the "Not shared" line has failed and should move above the ✓ list, or become the
headline. We would rather test that than assume it, which is why it is currently below.

---

# 3. Reproducing everything

```bash
cd example/lend
npm install

npx tsc --noEmit          # clean
npm run build             # succeeds

npm run test:probe        # SDK wire-format evidence for §D3, D4, D6, D7, D8
npm run test:identity     # 31 HTTP checks against the gate — needs :3200 up
npm run test:claim        # 16 checks, the standing gate — needs :3200 and VouchMe on :3000
```

`test:identity` PART 1 runs against the dev server on :3200 with the **real** World endpoint and no
Identity Check credentials. PART 2 starts a second Lend on :3202 against a **stub verifier**, so the
branch where a verifier attests is actually executed.

The stub is unreachable from a production build. `src/lib/identityStore.ts` throws at import if
`LEND_IDENTITY_VERIFY_URL` is set while `NODE_ENV === "production"`, and `verifyEndpoint()` ignores
the variable there regardless. This is not theoretical: the first draft of `test/identity.mjs` used
`next start`, which forces `NODE_ENV=production`, and every route in PART 2 returned 500. The test
now uses `next dev` and says why in a comment. Every response from the stubbed path carries
`stubbedVerifier: true`.

## Policy as built

| Pool | Pays | Standing gate (VouchMe) | Identity gate | Attributes requested |
|---|---|---|---|---|
| Starter | 0.05 WLD | Tier 1 | 18+ | `minimum_age: 18` |
| Standard | 0.10 WLD | Tier 2 | 18+, licensed country | `minimum_age: 18`, `issuing_country: <declared>` |
| Prime | 0.20 WLD | Score 105+ | 18+, licensed country | `minimum_age: 18`, `issuing_country: <declared>` |

Never requested, on any pool: `full_name`, `document_number`, `nationality`, `document_type`.
Reasoning for each, including the ones we decline, is in the header of `src/lib/identity.ts`.

Served jurisdictions: `PRT ESP FRA DEU NLD IRL`. An allowlist, not a blocklist — the safe default for
an unrecognised jurisdiction is no.

## Files

| File | What it is |
|---|---|
| `src/lib/identity.ts` | Policy, attribute construction, consent copy, satisfaction check. The only place attributes are built. |
| `src/lib/identityStore.ts` | Challenges, attestations, nullifier index, config, and the production stub guard. |
| `src/app/api/identity/challenge/route.ts` | Signs `rp_context`, chooses attributes, refuses unserved jurisdictions before contacting World. |
| `src/app/api/identity/route.ts` | The boundary. Verifies server-side, requires `identity_attested === true` from World's reply. |
| `src/components/IdentityCheck.tsx` | Jurisdiction, consent, run, translate errors. Never reads `identity_attested`. |
| `src/lib/pools.ts` | Each pool's two requirements. |
| `src/app/api/claim/route.ts` | Step 5b — the identity gate, on the endpoint that moves money. |
| `test/identity.mjs` | 31 HTTP checks. |
| `test/probe-idkit.mjs` | Evidence for the SDK findings. Sends no proof. |

## What we could not verify, restated

1. Whether World's verify endpoint ever returns `identity_attested` (**D1**). If it does not, no
   safe server-side integration is possible and Lend will correctly refuse forever.
2. Whether World App renders our requested attributes on its own consent screen, and how.
3. Which convention `ResponseItemV4.signal_hash` uses for an Identity Check proof (**D3**).
4. The device-side error for an app id lacking entitlement (**D5**).
5. Whether a real attestation round-trips end to end. It cannot, today, for this app id.
6. Anything at all about how real users understand or respond to this flow.
