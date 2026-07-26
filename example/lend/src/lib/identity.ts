import type { IdentityAttribute } from "@worldcoin/idkit-core";

/**
 * The identity gate, and everything that decides what Lend is allowed to ask a person to prove.
 *
 * ── Why this is a SEPARATE gate from `pools.ts` ─────────────────────────────────────────────────
 *
 * VouchMe standing answers *how much do we trust you*. It is earned, revocable, and continuous.
 * Identity answers *may we legally serve you at all*. It is binary, statutory, and has nothing to do
 * with reputation: a person with a perfect score who is seventeen still may not borrow, and no
 * amount of vouching changes that. Conflating the two produces the classic compliance bug where a
 * high enough score buys its way past a legal limit.
 *
 * So the two gates are orthogonal and BOTH must pass. `qualifies()` in pools.ts never consults this
 * file, this file never consults a score, and `/api/claim` calls them one after the other with
 * separate refusal codes so a refused user is told which wall they hit.
 *
 * ── Why these attributes and no others ──────────────────────────────────────────────────────────
 *
 * `IdentityAttribute` (idkit-core 4.2.2) offers six types. Lend requests at most two:
 *
 *   minimum_age      REQUESTED. A consumer credit product may not be offered to a minor. This is
 *                    the only reason we ask, and 18 is the only number we ask about.
 *   issuing_country  REQUESTED, and only for pools whose jurisdiction is restricted. Lending is
 *                    licensed territorially; this decides whether we may offer the pool at all.
 *   nationality      NOT requested. Licensing follows the document's issuer and the borrower's
 *                    residence, not their citizenship. Asking would collect a protected
 *                    characteristic we have no use for.
 *   document_type    NOT requested. We do not care whether the person holds a passport or an eID,
 *                    only that the claims above hold. Pinning the type would exclude people for
 *                    no reason we could defend.
 *   full_name        NOT requested. Lend pays a wallet address. A name would be a liability we
 *                    would then have to store, secure and delete, in exchange for nothing.
 *   document_number  NOT requested. Same, but worse: it is a durable government identifier, and
 *                    the entire point of an attestation is that we never have to hold one.
 *
 * That last pair is not squeamishness. Identity Check exists so a relying party can learn a
 * *predicate* instead of a *document*. An integration that asks for `full_name` has rebuilt document
 * handling with extra steps and taken on every duty that comes with it.
 *
 * ── The one thing about this API that changes how you design ────────────────────────────────────
 *
 * Every `IdentityAttribute` carries a `value` YOU supply. This is an assertion-matching API, not a
 * disclosure API: you state "issuing country is PRT" and learn whether that matched. You are never
 * told what the country actually is. (Evidence: every variant is `{ type, value }`; the failure code
 * is `identity_attributes_not_matched`; `full_name: string` would be incoherent as an output.)
 *
 * The consequence is structural, so it is worth saying plainly: an allowlist of N jurisdictions
 * cannot be expressed in one request, and a blocklist cannot be expressed at all — equality does not
 * compose into "is one of" or "is not". So Lend has the person DECLARE their jurisdiction, refuses
 * the unserved ones before World is contacted at all, and then uses Identity Check to confirm the
 * declaration is document-backed. A false declaration fails the match. This is the honest shape of
 * the primitive, not a workaround for it — and it happens to leak less, because we only ever ask
 * about the one country the person already told us.
 */

/** ISO 3166-1 alpha-3, which is what `issuing_country` and `nationality` take. */
export type Alpha3 = string;

/**
 * Where Lend holds a lending licence. An allowlist, not a blocklist, because the safe default for
 * an unrecognised jurisdiction is "no" — a blocklist quietly serves every territory nobody thought
 * to add.
 *
 * Demo values. A real deployment's list is a legal artefact, not an engineering one.
 */
export const SERVED_JURISDICTIONS: readonly Alpha3[] = ["PRT", "ESP", "FRA", "DEU", "NLD", "IRL"] as const;

export const JURISDICTION_NAMES: Readonly<Record<string, string>> = {
  PRT: "Portugal",
  ESP: "Spain",
  FRA: "France",
  DEU: "Germany",
  NLD: "Netherlands",
  IRL: "Ireland",
};

export function isServedJurisdiction(country: unknown): country is Alpha3 {
  return typeof country === "string" && SERVED_JURISDICTIONS.includes(country);
}

/** The legal floor. Named rather than inlined so there is exactly one 18 in the codebase. */
export const MINIMUM_AGE = 18;

/**
 * What a pool needs proven about a person before it may be offered to them.
 *
 * `jurisdiction: "any"` still requires the age attestation — it means the pool is not territorially
 * restricted, not that identity is optional.
 */
export interface IdentityPolicy {
  minimumAge: number;
  jurisdiction: "any" | "served";
}

/** What Lend concluded, ITSELF, after verifying a proof server-side. Never a client's claim. */
export interface IdentityAttestation {
  /** Lowercased session address this attestation is bound to. */
  address: string;
  /** The age floor World matched. `null` if age was not part of the request. */
  minimumAge: number | null;
  /** The alpha-3 World matched against the person's declaration. `null` if not asked. */
  issuingCountry: Alpha3 | null;
  /** RP-scoped nullifier from the proof — one document, one account. */
  nullifier: string;
  attestedAt: number;
  expiresAt: number;
  /** "production" | "staging" | "sandbox", straight from the verify response. Surfaced because a
   *  staging attestation unlocking a real payout is a category of bug worth being loud about. */
  environment: string;
}

/**
 * The attributes to put on the wire for one policy and one declared jurisdiction.
 *
 * This is the ONLY place attributes are constructed, so "what does Lend ask World about a person"
 * has a single answer that can be read in ten seconds and diffed in review.
 */
export function attributesFor(policy: IdentityPolicy, declaredCountry: Alpha3 | null): IdentityAttribute[] {
  const attributes: IdentityAttribute[] = [
    // Asked on every pool: all of them pay out, and none may pay out to a minor.
    { type: "minimum_age", value: policy.minimumAge },
  ];
  if (policy.jurisdiction === "served") {
    if (!isServedJurisdiction(declaredCountry)) {
      // Refused here rather than on the wire. A person outside the licensed territory should never
      // be asked to open their document at all — the answer is already no.
      throw new IdentityPolicyError(
        `Lend is not licensed to offer this pool in the jurisdiction you selected. Served: ${SERVED_JURISDICTIONS.join(", ")}.`,
      );
    }
    // Asked only when the pool is territorially restricted. Confirms the declaration is
    // document-backed; tells us nothing else about the document.
    attributes.push({ type: "issuing_country", value: declaredCountry });
  }
  return attributes;
}

export class IdentityPolicyError extends Error {}

/**
 * Does a stored attestation satisfy a policy?
 *
 * Deliberately total and deliberately grumpy: an absent attestation, an expired one, one that
 * proved a lower age floor than this pool asks for, or one whose jurisdiction is no longer served,
 * all return false. There is no branch here that treats "we don't know" as "fine".
 */
export function attestationSatisfies(
  policy: IdentityPolicy,
  attestation: IdentityAttestation | null,
  now: number = Date.now(),
): boolean {
  if (!attestation) return false;
  if (attestation.expiresAt <= now) return false;
  if (attestation.minimumAge === null || attestation.minimumAge < policy.minimumAge) return false;
  if (policy.jurisdiction === "served") {
    if (!isServedJurisdiction(attestation.issuingCountry)) return false;
  }
  return true;
}

/** Six words at most — this sits on a pool card beside the standing requirement, and is also
 *  quoted back in refusals. No middot: the card already uses one to separate the two gates. */
export function identityLabel(policy: IdentityPolicy): string {
  return policy.jurisdiction === "served"
    ? `${policy.minimumAge}+, licensed country`
    : `${policy.minimumAge}+`;
}

/**
 * The consent sentence, written once and rendered verbatim on the screen that asks.
 *
 * Two rules it has to obey, and they are the reason it is generated rather than hand-written per
 * screen:
 *
 *  1. It names every attribute that goes on the wire. If `attributesFor` grows a field and this
 *     does not, the copy has become a lie — so both read the same policy object.
 *  2. It says what is NOT shared, explicitly. "We check you are over 18" leaves a reasonable person
 *     unsure whether their name and passport number came along for the ride. They did not, and the
 *     screen has to say so, because the user cannot see the payload.
 */
export function consentCopy(policy: IdentityPolicy, declaredCountry: Alpha3 | null): {
  shares: string[];
  withholds: string[];
  summary: string;
} {
  const shares = [`that you are ${policy.minimumAge} or older`];
  if (policy.jurisdiction === "served" && declaredCountry) {
    shares.push(`that your ID was issued by ${JURISDICTION_NAMES[declaredCountry] ?? declaredCountry}`);
  }
  return {
    shares,
    withholds: ["your name", "your ID number", "your date of birth", "your photo", "your address"],
    summary:
      `World App will answer yes or no to ${shares.length === 1 ? "one question" : `${shares.length} questions`} ` +
      `about your ID. Lend receives the answer, never the document.`,
  };
}
