# Aval × ENS

**The claim:** Aval does not display ENS names. Aval stores its trust graph *in* the ENS name tree.
A member is a registry contract. A vouch is a subname registered inside the voucher's registry. The
edge has no other representation — delete the name and the edge is gone.

`romariokavin.philoo.aval.eth` existing on Ethereum Sepolia **is** the statement "philoo vouched for
romariokavin." Not a label for it. The statement itself.

Everything below was re-verified against the live chain while writing this document. Where a repo
file disagreed with the chain, the chain won and the disagreement is called out.

---

## Verify it in 60 seconds, with tooling we didn't write

```js
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
const c = createPublicClient({ chain: sepolia, transport: http() });

await c.getEnsAddress({ name: "erin.carol.alice.aval.eth" });
// 0x30F99b23402377BC829e573389c2317f97db8740

await c.getEnsAddress({ name: "romariokavin.philoo.aval.eth" });
// 0x4774b9621102eAc2254365f9311C4E7700D9e7de
```

That is stock viem, stock chain config, no Aval code. Under the hood it goes through the ENS
UniversalResolver at `0xeeeeeeee14d718c2b47d9923deab1335e144eeee` (2491 bytes on Sepolia), which
walks the ENSv2 registry tree to find the resolver:

```
UR.resolve("erin.carol.alice.aval.eth")  -> addr=0x30F99b23402377BC829e573389c2317f97db8740
                                            resolverUsed=0x211D6CC339C7C6E4B4448c04cD034E363d9994d3
UR.resolve("romariokavin.philoo.aval.eth") -> addr=0x4774b9621102eAc2254365f9311C4E7700D9e7de
                                            resolverUsed=0x211D6CC339C7C6E4B4448c04cD034E363d9994d3
UR.resolve("alice.aval.eth")             -> addr=0xEe0f520A7Cd3F6998dEE6463dfE3fc49E040520B
                                            resolverUsed=0x211D6CC339C7C6E4B4448c04cD034E363d9994d3
```

**Chain:** Ethereum Sepolia (11155111). **Root name:** `aval.eth`.
**All writes from:** `0x69827C0FEF274C63Ac4806106F2BA544E6129050` (see [Limitations](#what-is-not-done)).

---

## 1. This is ENSv2. Reading v1 to check it will mislead you

`aval.eth` has **no forward record in the v1 flat registry**. If you check it there you will conclude
the name doesn't exist:

```
v1.owner("eth")                  = 0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85   (BaseRegistrar — the call path works)
v1.owner("aval.eth")             = 0x0000000000000000000000000000000000000000
v1.resolver("aval.eth")          = 0x0000000000000000000000000000000000000000
v1.owner("carol.aval.eth")       = 0x0000000000000000000000000000000000000000
v1.owner("carol.alice.aval.eth") = 0x0000000000000000000000000000000000000000
```
*(v1 ENS Registry `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`. The first line is the control: the
registry answers correctly for `eth`, so the zeroes are real absences, not a dead call.)*

**This was the mistake actually made in this project**, and it is recorded in
`deployments/ens-sepolia.json` → `notes` / `ensv1.conclusion`. There is a second, sharper version of
the trap still live on chain:

```
v1.resolver("69827c0f…e6129050.addr.reverse") = 0xE99638b40E4Fff0129D56f03b55b6bbC4BBE49b5
  .name(node)                                 = "aval.eth"
```

The deployer has a **v1 reverse record claiming `aval.eth`** — set by two `setName()` calls that
never touched name ownership. A v1-based explorer will happily print "aval.eth" next to that address.
That is an unverified claim from the address side and proves nothing. Ignore it. It is not how any
of this works.

### Where the name actually lives

ENSv2 replaces one flat registry with **one registry contract per name that has children**, reached
through `IRegistry`:

```solidity
function getSubregistry(string label) external view returns (IRegistry);
function getResolver(string label)    external view returns (address);
function getParent() external view returns (IRegistry parent, string label);
```

Live chain of custody, read top-down:

```
ethRegistry.getParent()             = [0xc960F7217d3643B525Ef36Bec8Adf86953CD9aB8, "eth"]   (root registry)
ethRegistry (PermissionedRegistry)  = 0xDEDB92913A25abE1f7BCDD85D8A344a43B398B67   code=15453B
ethRegistry.getSubregistry("aval")  = 0xb8C3d3AD86b0b66CE5401c81e9c4a037DF69eF33   ← aval.eth's own registry
avalRegistry.roles(0, deployer)     = 0x1111111111111111111111111111111111111111111111111111111111111111
```

That last line is `RegistryRolesLib`'s 64-slot nybble-packed bitmap with every nybble set — the
deployer holds all roles on `aval.eth`'s root resource, which is what lets it `register()`.
This value was read off chain, not assumed; `ens-core.ts` hardcodes it as `ALL_ROLES` *because* it
was read back first.

Source-verification status, queried from Sourcify while writing this (chainId 11155111):

| Contract | Sourcify |
|---|---|
| `.eth` registry `0xDEDB9291…B398B67` — `PermissionedRegistry` | `exact_match` (creation + runtime) |
| Resolver implementation `0xdcE5205A…6022FfA` — `PermissionedResolver` | `exact_match` (creation + runtime) |
| Registry implementation `0x0F99e7Ea…6f92917` | **`null` — not verified** |
| `VerifiableFactory` `0xD2a632D8…7236198` | **`null` — not verified** |

So the ABI and semantics come from a verified contract, but the implementation the member registries
actually execute is not source-verified. It is confirmed *functionally*: every call in the verified
parent's ABI (`register`, `setSubregistry`, `findOwner`, `findTokenId`, `findExpiry`,
`getSubregistry`, `getResolver`, `hasRoles`, `roles`) succeeds against it with semantically correct
results. The 77-byte clones themselves are EIP-1167 stubs with nothing to verify.

---

## 2. A member *is* a registry they own

Not "a member has a name." A member owns a `PermissionedRegistry` clone, and that clone is what
`Entry.subregistry` points at. Without it, `<someone>.<member>.aval.eth` is structurally impossible —
which is exactly the bug this project shipped first and then fixed (see §5).

The clone is deployed through the shared `VerifiableFactory`
(`0xD2a632D8a8b67c2c4398c255CbD7aF8dd7236198`, `deployProxy(address,uint256,bytes)` = `0x5d84121a`)
at a CREATE2 address derived **from the label alone**:

```
salt(label) = uint256(keccak256(utf8("aval.eth/member-registry/v1::" + label)))
outerSalt   = keccak256(abi.encode(deployer, salt))
runtime     = 0x363d3d373d3d3d363d73 ‖ 0x917c561a…30c5A ‖ 0x5af43d82803e903d91602b57fd5bf3 ‖ outerSalt
creation    = 0x3d604d80600a3d3981f3 ‖ runtime
address     = CREATE2(VerifiableFactory, outerSalt, keccak256(creation))
```

`app/src/lib/ens-core.ts:279` (`predictMemberRegistryAddress`). Two consequences that matter:

- **Offline re-derivability.** Given only the string `alice`, you can compute
  `0xeB3e71b211B947a7EF4EbC1Cb7d4ae7e97eCf143` with no RPC, no receipt, no database.
- **Idempotence for free.** `deployMemberRegistry` checks `eth_getCode` at the predicted address
  first and returns without writing if code is already there. Re-running the provisioner is a no-op
  rather than a CREATE2 collision.

I re-derived all 19 addresses offline and compared to `getSubregistry(label)` read live:

```
alice        predicted=0xeB3e71b211B947a7EF4EbC1Cb7d4ae7e97eCf143 onchainMatch=true code=77B
bob          predicted=0x7FdB73963A3Ed5314806A8d427B6b2eF99d5c8f9 onchainMatch=true code=77B
carol        predicted=0x3f04Cac222A9627F9De911b274CdF289bbA008d9 onchainMatch=true code=77B
dave         predicted=0xB5756E046274fC1ca0e3e7835F587BC0364f3E9D onchainMatch=true code=77B
erin         predicted=0xbD0805Db6f42e570FeEC0966A0531762A7472b83 onchainMatch=true code=77B
anchor1..6   predicted=0x53E0791B… 0x0cbc34A7… 0x49158672… 0xdE3E0156… 0x9d3126B5… 0x4b89c212…  all onchainMatch=true code=77B
ring1..6     predicted=0x5a351bE8… 0x85Dce087… 0x9EC7c2ef… 0xCf71e590… 0x54E6050c… 0x4a9D8434…  all onchainMatch=true code=77B
philoo       predicted=0xdC216d65d13ECF88069d3901B69990ef82bBdD47 onchainMatch=true code=77B
romariokavin predicted=0xf86c82f9941680E30746aE83B7977409C76175Ec onchainMatch=true code=77B

registered labels: 19   distinct registries: 19
```

Spot-check of the salt function itself:

```
salt("philoo")       = 0xbd8c15d099a3d5101daa34631c98436faf46b973ab26fcc6d9fe03c46143bfd2
salt("romariokavin") = 0x992afefd4f233003f420bd42b933abdb3e4c52c6ece985602ae9010747a503b0
```

Both appear verbatim as the `salt` argument of the real `deployProxy` transactions
(`0x65f1569c…`, `0xd08fc302…`). The derivation is the one the factory actually used.

---

## 3. A vouch *is* a subname

Issuing a vouch is `register()` **inside the voucher's own registry** — `ens-core.ts:533`:

```solidity
register(voucheeLabel, deployer, voucheeRegistry, resolver, ALL_ROLES, now + 90 days)
```

Decoded from the real, user-triggered vouch transaction
[`0x5a31e21f4a4018ba3ff4dd78b35fcbfea6073af24a02aa6c0c3b9ae99a98fb98`](https://sepolia.etherscan.io/tx/0x5a31e21f4a4018ba3ff4dd78b35fcbfea6073af24a02aa6c0c3b9ae99a98fb98):

```
to        : 0xdC216d65d13ECF88069d3901B69990ef82bBdD47   ← philoo's registry, not aval.eth's
label     : romariokavin
registry  : 0xf86c82f9941680E30746aE83B7977409C76175Ec   ← romariokavin's OWN registry
resolver  : 0x211D6CC339C7C6E4B4448c04cD034E363d9994d3
roleBitmap: 0x1111…1111
expiry    : 1792782393  (2026-10-23T19:06:33Z)
```

Three properties fall out of the data structure rather than out of code we wrote:

| Aval concept | ENSv2 mechanism | Verified |
|---|---|---|
| Trust edge `philoo → romariokavin` | the subname exists | `philooRegistry.findOwner("romariokavin") != 0` |
| Depth in the graph | label count in the name | `erin.carol.alice.aval.eth` is depth 3, by inspection |
| Vouch expiry (90 d) | `Entry.expiry`, native to ENS | `1792782393` — see §6 |
| Walking a trust path | repeated `getSubregistry()` | §4 |

### The trap: `register()` without `setAddr()`

`register()` writes the **registry entry** — owner, subregistry pointer, expiry, and a *pointer* to a
resolver. It does not write an address record. The receipt is `status: success` and indistinguishable
from a complete mint, but the name resolves to nothing.

This project hit it. From `deployments/ens-sepolia.json`, recorded at the time:

```
carolAvalEth.readbackVerification:
  "avalRegistry.getResolver('carol')  == 0x211D6CC3…"        ← pointer wired
  "resolver.addr(namehash('carol.aval.eth')) == 0x0"         ← name resolves to NOTHING
```

The fix is structural, not a comment. `ens-core.ts` will not report success on a receipt:

- `assertWired()` (line 633) re-reads `addr()`, `getSubregistry()` and `eth_getCode(subregistry)`
  from a fresh call after every write, and throws if any is wrong.
- `EnsMintPartialError` (line 226) is a distinct type for "registered, but the address record
  failed", carrying the instruction that a retry must redo `setAddr` only — calling `register()`
  again on a taken label reverts.
- `EnsVouchNestingUnavailableError` (line 241) is thrown when the voucher owns no registry;
  `/api/vouch/ens` turns it into a `409 vouch_name_unavailable` and the wizard says the name was
  **not** minted. A screen saying "Minted" while nothing was minted is worse than one saying
  "unavailable."

The same `ens-core.ts` is imported by `/api/ens/mint`, `/api/vouch/ens` and
`scripts/dev/ens-provision.mts`, so the operational script cannot drift from the app.

---

## 4. The four-level traversal

`node scripts/dev/ens-walk.mjs erin.carol.alice.aval.eth`, run just now:

```
aval.eth                   parentRegistry=0xDEDB92913A25abE1f7BCDD85D8A344a43B398B67
                           owner=0x69827C0FEF274C63Ac4806106F2BA544E6129050 resolver=0x211D6CC339C7C6E4B4448c04cD034E363d9994d3 expiry=1848158652 (2028-07-25T17:24:12.000Z)
                           getSubregistry("aval")=0xb8C3d3AD86b0b66CE5401c81e9c4a037DF69eF33 code=77B
alice.aval.eth             parentRegistry=0xb8C3d3AD86b0b66CE5401c81e9c4a037DF69eF33
                           owner=0x69827C0FEF274C63Ac4806106F2BA544E6129050 resolver=0x211D6CC339C7C6E4B4448c04cD034E363d9994d3 expiry=1816531850 (2027-07-25T16:10:50.000Z)
                           getSubregistry("alice")=0xeB3e71b211B947a7EF4EbC1Cb7d4ae7e97eCf143 code=77B
carol.alice.aval.eth       parentRegistry=0xeB3e71b211B947a7EF4EbC1Cb7d4ae7e97eCf143
                           owner=0x69827C0FEF274C63Ac4806106F2BA544E6129050 resolver=0x211D6CC339C7C6E4B4448c04cD034E363d9994d3 expiry=1792771911 (2026-10-23T16:11:51.000Z)
                           getSubregistry("carol")=0x3f04Cac222A9627F9De911b274CdF289bbA008d9 code=77B
erin.carol.alice.aval.eth  parentRegistry=0x3f04Cac222A9627F9De911b274CdF289bbA008d9
                           owner=0x69827C0FEF274C63Ac4806106F2BA544E6129050 resolver=0x211D6CC339C7C6E4B4448c04cD034E363d9994d3 expiry=1792772705 (2026-10-23T16:25:05.000Z)
                           getSubregistry("erin")=0xbD0805Db6f42e570FeEC0966A0531762A7472b83 code=77B
resolver.addr(namehash("erin.carol.alice.aval.eth")) = 0x30F99b23402377BC829e573389c2317f97db8740
```

Read the `parentRegistry` column downward. Each line's registry is the previous line's
`getSubregistry` result. **The traversal is the graph walk.** No BFS engine ran here; four
`getSubregistry` calls did the whole job, and each hop is a different contract owned by a different
member.

Note the expiries: the two member names sit at ~1 year, the two vouch edges at 2026-10-23 — 90 days,
the same constant as `AvalRegistry.VOUCH_EXPIRY = 90 days` in the World Chain contract. Vouch expiry
is not a predicate we evaluate. It is `Entry.expiry` in ENS.

### Negative controls

Structure that should not resolve, doesn't:

```
addr("mallory.aval.eth")              = 0x0    avalRegistry.findOwner("mallory")        = 0x0
addr("dave.alice.aval.eth")           = 0x0    (alice never vouched for dave)
addr("erin.bob.aval.eth")             = 0x0    bobRegistry.findOwner("erin")            = 0x0
addr("x.erin.carol.alice.aval.eth")   = 0x0
```

An unvouched-for name is not "a name with a low score." It does not exist.

---

## 5. The depth-3 subtlety, and what it tells you about the design

`erin.carol.alice.aval.eth` required **no third `register()` call**. There is exactly one
`register("erin", …)` transaction — `0xae5f361e…`, sent to carol's registry
`0x3f04Cac222A9627F9De911b274CdF289bbA008d9`.

The reason is that carol has **one** registry, and it is simultaneously:

- `avalRegistry.getSubregistry("carol")` — the child of `carol.aval.eth`, and
- `aliceRegistry.getSubregistry("carol")` — the child of `carol.alice.aval.eth`.

Both read back as the same address:

```
carol.alice.aval.eth   childRegistry=0x3f04Cac222A9627F9De911b274CdF289bbA008d9  identicalTo<carol>.aval.eth's=true
erin.carol.aval.eth    childRegistry=0xbD0805Db6f42e570FeEC0966A0531762A7472b83  identicalTo<erin>.aval.eth's=true
```

So the single `erin` entry inside carol's registry is reachable through *every* path that reaches
carol. **Registry state is per-edge; reachability is transitive for free.** That is the property that
makes the name tree a real graph rather than a list of strings.

The resolver does not share that property. It is **node-keyed** — `addr(bytes32 node)` — and
`namehash` includes the full path:

```
namehash("erin.carol.alice.aval.eth") = 0x516166d6c2a8388d3bdf3bba132203ad6cdf297ab26874dccbee3c557373e25e
namehash("erin.carol.aval.eth")       = 0x491990ed7e25f0a94eb5a5bb5beff6ea0a676e27d2f6b1a1f70a450c361ad8f3
```

So the depth-3 leaf needed its own `setAddr`, and only that. Verified by decoding the transaction:

```
tx 0xdea4291e5571c13b0740905e2b308b5248f6a6d581fa659085c996beb92c32c4  (block 11348817, success)
to    0x211D6CC339C7C6E4B4448c04cD034E363d9994d3
input 0xd5fa2b00 516166d6…e25e  …30F99b23402377BC829e573389c2317f97db8740
      └ setAddr  └ namehash("erin.carol.alice.aval.eth")  └ erin's address
```

Two layers, two different addressing models — registry state keyed by (registry, label), resolver
state keyed by namehash. Aval's trust graph lives entirely in the first. The second is a display
concern. `deployments/ens-sepolia.json` → `nestedVouchNames.resolverNote` states this in one line;
this is what it means in practice.

---

## 6. The one path with no seeding in it

The 17 demo labels (`alice`…`ring6`) were provisioned by a script. Two names were not:

**On World Chain mainnet (480), `AvalRegistry` `0x6fEfEf2d44203300a6a33d631840C972181b8722`** has
emitted five events in its entire life — two of them deploy-time wiring (`ReportRegistrySet`,
`PlatformRegistrySet`, blocks 32833184/32833186). The other three are the whole user story:

```
block 32833568  Enrolled  0xB23a3B…672B47  handle="philoo.aval.eth"        tx 0xde6f732e…
block 32833881  Enrolled  0x4774b9…D9e7de  handle="romariokavin.aval.eth"  tx 0xcbafd84a…
block 32835377  Vouched   0xB23a3B…672B47 -> 0x4774b9…D9e7de
                          issuedAt=1785006393 (2026-07-25T19:06:33Z)
                          expiresAt=1792782393 (2026-10-23T19:06:33Z)   tx 0x563172cb…
```

Two users, one vouch. That is a small graph, and stating its size is more useful to you than a
seeded number would be.

**On Ethereum Sepolia**, the app's own routes then produced, unattended:

| # | block | tx | what |
|---|---|---|---|
| 1 | 11349301 | `0x65f1569ca3bdc9363688eaeacd44e1fc470fbfb779d46dc62ce362cdfffa6368` | `deployProxy` salt `0xbd8c15d0…` → philoo's registry |
| 2 | 11349302 | `0xde24f630b0224a3db0282a7b70589cc80d88a57cf5e8cf41d2624efa60be6dc5` | `register("philoo")`, registry = `0xdC216d65…` |
| 3 | 11349303 | `0x41c79ba980f8af41abe5aaa2728c73dfbfa9ec17b508d83d60bc25d60ed073d7` | `setAddr(philoo.aval.eth → 0xB23a3B…672B47)` |
| 4 | 11349351 | `0xd08fc3022034ef62445b0c90529c3a0489df1049bf645fd3cf605e8bbb287f0d` | `deployProxy` salt `0x992afefd…` → romariokavin's registry |
| 5 | 11349352 | `0xfa9b011adb2ec1975c02cb599b4c77bbc8b53e4bb52e374c19d74693d701ba2c` | `register("romariokavin")` |
| 6 | 11349353 | `0x4a68814e1a5e2c37af542cffc21547b80bfa18176740b112e6e05808b79e5f2f` | `setAddr(romariokavin.aval.eth → 0x4774b9…D9e7de)` |
| 7 | 11349597 | `0x5a31e21f4a4018ba3ff4dd78b35fcbfea6073af24a02aa6c0c3b9ae99a98fb98` | **`register("romariokavin")` inside philoo's registry** |
| 8 | 11349599 | `0x49235bc8d4a33b22d24f46837fb26bf368dec453c8835aa9965442d02ebbdf6a` | `setAddr(romariokavin.philoo.aval.eth → 0x4774b9…D9e7de)` |

Rows 1–3 and 4–6 are `/api/ens/mint` firing from the enroll screen. Rows 7–8 are `/api/vouch/ens`
firing from the vouch wizard, three seconds after the World Chain vouch landed. The expiries line up
exactly:

```
philooRegistry.findExpiry("romariokavin") = 1792782393  (2026-10-23T19:06:33Z)
World Chain Vouched.expiresAt             = 1792782393  (2026-10-23T19:06:33Z)
```

Honest caveat on that: the ENS expiry is computed independently as `Date.now() + 90d` at mint time,
not read from the World Chain event. It matches to the second here because both were issued within
the same second (Sepolia block timestamp 1785006396, World Chain block 1785006393). The *constant*
matching is by design; the *second* matching is luck.

### Correction to the repo's own ledger

`deployments/ens-members-sepolia.json` says `membersProvisioned: 17`. **The live count is 19.**
`scripts/dev/ensstate.mjs` also shows only 17 — it iterates a hardcoded label array (line 24) that
predates the real users. Both files were written at 16:24 UTC; philoo and romariokavin arrived at
~19:00. Enumerated directly from chain, ignoring both files:

```
19 registered labels, 19 distinct registries, every one with code

nested vouch names present on chain:
  carol.alice.aval.eth          in=0xeB3e71b2… child=0x3f04Cac2… sameAsMemberRegistry=true addr=0x23761b08… exp=2026-10-23
  erin.carol.aval.eth           in=0x3f04Cac2… child=0xbD0805Db… sameAsMemberRegistry=true addr=0x30F99b23… exp=2026-10-23
  romariokavin.philoo.aval.eth  in=0xdC216d65… child=0xf86c82f9… sameAsMemberRegistry=true addr=0x4774b962… exp=2026-10-23

depth 3:
  addr("erin.carol.alice.aval.eth") = 0x30F99b23402377BC829e573389c2317f97db8740
```

---

## 7. Why this is not a mapping plus a label

A `mapping(address => address[]) vouches` with an ENS name rendered next to each row gives you the
same UI. It does not give you these:

- **The provenance is inside the identifier.** You cannot hand someone
  `erin.carol.alice.aval.eth` without also handing them the path. There is no way to display the
  identity while suppressing where it came from.
- **The path walk is ENS resolution.** `getSubregistry()` four times. Any client that can resolve an
  ENS name can walk an Aval trust path, having never heard of Aval. The stock viem call at the top of
  this document is the proof.
- **Expiry is native.** `Entry.expiry` is enforced by ENS itself. No `expiresAt_gt: now` predicate to
  forget in a query.
- **The attack is unrepresentable rather than filtered.** A collusion ring can mint
  `mallory.mallory2.mallory3.eth` all day; those labels do not descend from `aval.eth`, so there is
  nothing to detect. Contrast a mapping, where the ring's rows exist and you must *decide* to exclude
  them.
- **Revocation propagates by absence.** Nothing needs to publish a revocation list; the name stops
  resolving and every counterparty finds out on their next lookup. (Today only expiry does this —
  see below.)

---

## What is not done

Everything in this section was checked, not guessed.

**1. Two chains, no bridge.** Names are on Ethereum Sepolia (11155111). The app and `AvalRegistry`
are on World Chain **mainnet** (480, `NEXT_PUBLIC_CHAIN_ID=480`). Nothing on either chain proves
anything about the other — the only thing connecting the World Chain `Vouched` event to the Sepolia
subname is our server, holding a key, choosing to write both. A judge should read the ENS layer as
*a faithful mirror of the trust graph*, not as its trust root. (The comment at
`app/src/lib/ens.ts:6` still says World Chain **Sepolia** 4801; that is stale — 4801 has zero
enrollments today.)

**2. Everything is custodial.** `owner` on all 19 member names, all 3 vouch names and all 19
registries is `0x69827C0FEF274C63Ac4806106F2BA544E6129050`, the deployer. "Your registry" is ours.
Users hold no key to any of it and cannot register, transfer or burn anything themselves. This is a
real gap between the design and the deployment, not a rounding error — the whole "a member is a
registry they own" story is currently "a member is a registry we own on their behalf."

**3. Vouches are not soulbound.** `docs/04-ens.md` §7.2 requires `ROLE_CAN_TRANSFER` to be revoked at
mint, because a transferable vouch is a vouch with a marketplace. The live code passes
`roleBitmap = ALL_ROLES` (`0x1111…1111`) — verified in the real vouch calldata above — which grants
the transfer role rather than revoking it. Not implemented.

**4. No slot limits, no rate limits, no depth cap in ENS.** §7.1/7.3 describe an `AvalMemberRegistry`
subclass enforcing 3-or-10 outbound slots and a 1-per-day rate limit in the member's own contract.
What is deployed is the stock `PermissionedRegistry` clone; those rules live only in `AvalRegistry`
on World Chain. Likewise, `docs/04-ens.md` §5.3's "`x.y.z.w.aval.eth` does not resolve — beyond
max_depth" is true today only because nobody registered it. erin's registry
`0xbD0805Db6f42e570FeEC0966A0531762A7472b83` has 77 bytes of code, so a 4th label under it is
structurally available. ENS caps nothing.

**5. No text records.** `docs/04-ens.md` §2 describes `aval.score`, `aval.tier`, `aval.path`,
`aval.subgraph` computed at resolution time. On chain, right now:

```
text("erin.carol.alice.aval.eth","aval.score")    = ""
text("erin.carol.alice.aval.eth","aval.tier")     = ""
text("erin.carol.alice.aval.eth","aval.path")     = ""
text("erin.carol.alice.aval.eth","aval.subgraph") = ""
text("alice.aval.eth","avatar")                   = ""
```

Empty on every name tested. The names carry an address record and nothing else.

**6. The CCIP-Read gateway is not in the resolution path.** `gateway/` exists as a real package
(ENSIP-10 wildcard decoding, EIP-3668 request handling, EIP-191 signing, with tests). It is not
deployed, no L1 CCIP resolver contract appears in any file under `deployments/`, and `aval.eth`'s
resolver on chain is the plain `PermissionedResolver` clone — which is why §5 above returns empty
strings. The §3 architecture diagram in `docs/04-ens.md` describes a system that is written but not
wired.

**7. No reverse resolution.** No member address has an `addr.reverse` resolver set;
`getEnsName()` returns `null` for every one. `docs/04-ens.md` §1.1's canonical-name selection is
unimplemented — and since a person can hold several names (`carol.aval.eth`, `carol.alice.aval.eth`),
reverse resolution is where that ambiguity would have to be resolved.

**8. Revocation only happens by expiry.** `ens-core.ts` has no burn or revoke path. A World Chain
`Revoked` event does not remove the subname; the name keeps resolving until `Entry.expiry` lapses,
up to 90 days later.

**9. Sepolia only.** `aval.eth` is registered under an ENSv2 alpha stack on Sepolia. There is no
mainnet `aval.eth`, and no ENSIP-25/26 agent records exist on chain (`docs/04-ens.md` §4 is design
only).

---

## Reproduce

```bash
node scripts/dev/ens-walk.mjs erin.carol.alice.aval.eth      # the four-level traversal
node scripts/dev/ens-walk.mjs romariokavin.philoo.aval.eth   # the user-generated edge
node scripts/dev/ensstate.mjs                                # per-member registries (17 seeded only — see §6)
```

Requires `ETH_SEPOLIA_RPC` in `.env`. Note that `ensstate.mjs` reads a hardcoded label list and will
not show `philoo` or `romariokavin`; use `ens-walk.mjs` or a direct `getSubregistry` call for those.

| | |
|---|---|
| Design | `docs/04-ens.md` (§7, §7.1) |
| Verified deployment record | `deployments/ens-sepolia.json` — read the `notes` and `ensv2` blocks |
| Per-member ledger | `deployments/ens-members-sepolia.json` (stale at 17 of 19) |
| Implementation | `app/src/lib/ens-core.ts` — all addresses, ABIs, derivations and read-back gates |
| App wiring | `app/src/lib/ens.ts`, `app/src/app/api/ens/mint/route.ts`, `app/src/app/api/vouch/ens/route.ts` |
