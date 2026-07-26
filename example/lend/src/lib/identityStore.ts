import "server-only";

import type { IdentityAttestation, IdentityPolicy, Alpha3 } from "./identity";

/**
 * Server-side state for the identity gate: outstanding challenges, and the conclusions Lend reached
 * about them.
 *
 * THIS IS IN MEMORY AND IS LOST ON RESTART, exactly like `claims.ts`, and for the same reason: this
 * file is the shape of the storage a real deployment needs, not a substitute for it. A restart makes
 * everyone re-attest, which is annoying and safe. A second process has its own empty copy, which is
 * also annoying and also safe — both failure directions are "ask again", never "let through".
 *
 * Pinned to `globalThis` because Next gives each route handler its own module instance. Without it
 * the challenge minted by `/api/identity/challenge` would be invisible to `/api/identity`, and
 * single-use would silently mean once-per-module-instance.
 */

// ─── the stub guard, first, because everything below is only safe if this holds ──────────────────

export class IdentityConfigError extends Error {}

/**
 * Points the World ID verify POST somewhere else. FOR TESTS ONLY.
 *
 * `test/identity.mjs` needs to exercise the branch where World says yes — otherwise the allow path
 * of a preview-gated feature is dead code that has never once been executed, and "it fails closed"
 * would be a claim about code nobody ran. So the test stands up a fake verifier and points this at
 * it, the same way `test/claim.mjs` stands up a fake VouchMe.
 *
 * It is guarded twice, and the guards are the load-bearing part:
 *
 *  1. `verifyEndpoint()` ignores this variable entirely when NODE_ENV is "production". Even if it
 *     is set on a production deploy, the real endpoint is used.
 *  2. The module refuses to load at all in that situation. Silently ignoring the flag is the wrong
 *     failure: whoever set it believes verification is being redirected, and would not find out
 *     otherwise. Crashing at import names the mistake at the moment it is made.
 *
 * `NODE_ENV` is set to "production" by `next build` / `next start` and cannot be overridden from the
 * environment the way a NEXT_PUBLIC_ var can, so (1) is a condition a misconfigured deploy cannot
 * flip. Pattern lifted from `app/src/lib/authSession.ts`, which learned it the hard way.
 */
const WORLD_VERIFY_BASE = "https://developer.world.org/api/v4/verify";

if (process.env.NODE_ENV === "production" && process.env.LEND_IDENTITY_VERIFY_URL) {
  throw new IdentityConfigError(
    "LEND_IDENTITY_VERIFY_URL is set on a production build. That variable redirects World ID proof " +
      "verification away from developer.world.org and exists only so the test suite can exercise " +
      "the allow branch against a local stub. Unset it, or run a development build.",
  );
}

export function verifyEndpoint(rpId: string): string {
  if (process.env.NODE_ENV !== "production" && process.env.LEND_IDENTITY_VERIFY_URL) {
    return `${process.env.LEND_IDENTITY_VERIFY_URL.replace(/\/$/, "")}/${rpId}`;
  }
  return `${WORLD_VERIFY_BASE}/${rpId}`;
}

/** True when proofs are being verified by something other than World. Surfaced in responses so a
 *  passing test can never be mistaken for a real attestation. */
export function isStubbedVerifier(): boolean {
  return process.env.NODE_ENV !== "production" && Boolean(process.env.LEND_IDENTITY_VERIFY_URL);
}

export interface WorldIdConfig {
  appId: string;
  rpId: string;
  action: string;
  signingKey: string;
}

/**
 * The World ID credentials this feature needs, or a refusal naming what is missing.
 *
 * Throws rather than returning a partial config: a half-configured World ID integration that
 * silently skips a step is precisely the failure mode this whole feature exists to avoid.
 */
export function worldIdConfig(): WorldIdConfig {
  const appId = process.env.NEXT_PUBLIC_APP_ID;
  const rpId = process.env.LEND_WORLDID_RP_ID;
  const action = process.env.LEND_WORLDID_ACTION;
  const signingKey = process.env.LEND_WORLDID_SIGNING_KEY;
  const missing = [
    appId ? null : "NEXT_PUBLIC_APP_ID",
    rpId ? null : "LEND_WORLDID_RP_ID",
    action ? null : "LEND_WORLDID_ACTION",
    signingKey ? null : "LEND_WORLDID_SIGNING_KEY",
  ].filter(Boolean);
  if (missing.length) {
    throw new IdentityConfigError(
      `Identity Check is not configured on this server (missing ${missing.join(", ")}). No pool that ` +
        `requires an identity attestation can be opened until it is.`,
    );
  }
  return { appId: appId!, rpId: rpId!, action: action!, signingKey: signingKey! };
}

// ─── challenges ──────────────────────────────────────────────────────────────────────────────────

/**
 * A challenge is the binding between "this browser is about to run an Identity Check" and "this
 * verified session address asked for it, for this policy".
 *
 * It exists because `identityCheck()` gives a v4 integration NO signal parameter — the only knob is
 * `legacy_signal`, and its name says what it is for. We do set it (it turns out to reach the v4
 * credential requests too — see IDENTITY-CHECK-TESTING.md §D3) and we do check the resulting
 * `signal_hash` when one comes back, but that check cannot be the only binding, because a response
 * that simply omits `signal_hash` would then bind to nothing at all.
 *
 * So the primary binding is the rp_context nonce, which we mint, which is single-use, and which
 * comes back on the result envelope as `IDKitResultV4.nonce`. A proof generated for one session
 * cannot be posted by another, because the nonce that produced it was issued to one address and is
 * burned on first use.
 */
export interface Challenge {
  nonce: string;
  address: string;
  policy: IdentityPolicy;
  declaredCountry: Alpha3 | null;
  /** The exact string put in `legacy_signal`, so the server can recompute its hash. */
  signal: string;
  expiresAt: number;
}

const CHALLENGE_TTL_MS = 10 * 60 * 1000;

/** 30 days. Long enough that nobody re-attests on a page load; short enough that a stale
 *  conclusion about a person's eligibility does not outlive the document it was drawn from. */
export const ATTESTATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface Store {
  challenges: Map<string, Challenge>;
  attestations: Map<string, IdentityAttestation>;
  /** nullifier -> address. One document, one account. */
  nullifiers: Map<string, string>;
}

const g = globalThis as typeof globalThis & { __lendIdentity?: Store };
const store: Store = (g.__lendIdentity ??= {
  challenges: new Map(),
  attestations: new Map(),
  nullifiers: new Map(),
});

function sweep(now: number): void {
  for (const [k, c] of store.challenges) if (c.expiresAt < now) store.challenges.delete(k);
}

export function putChallenge(challenge: Challenge): void {
  sweep(Date.now());
  store.challenges.set(challenge.nonce, challenge);
}

/**
 * Redeem a challenge, or say why not. BURNS IT on the way out, whatever the caller does next, so a
 * proof that fails verification cannot be resubmitted against the same challenge while an attacker
 * grinds at the rest of the request. Same ordering rule as `consumeNonce` in session.ts.
 */
export function takeChallenge(nonce: unknown, address: string): { ok: true; challenge: Challenge } | { ok: false; reason: string } {
  if (typeof nonce !== "string" || !nonce) return { ok: false, reason: "The proof carries no request nonce." };
  const now = Date.now();
  sweep(now);
  const challenge = store.challenges.get(nonce);
  if (!challenge) {
    return { ok: false, reason: "This verification request is unknown, already used, or expired. Start again." };
  }
  store.challenges.delete(nonce);
  if (challenge.expiresAt < now) return { ok: false, reason: "This verification request expired. Start again." };
  if (challenge.address !== address.toLowerCase()) {
    // The proof was requested by one signed-in account and posted by another. Refused loudly: this
    // is the shape of a stolen-proof attempt, not a mistake.
    return { ok: false, reason: "This verification was started by a different account." };
  }
  return { ok: true, challenge };
}

// ─── attestations ────────────────────────────────────────────────────────────────────────────────

export function getAttestation(address: string | null): IdentityAttestation | null {
  if (!address) return null;
  const found = store.attestations.get(address.toLowerCase());
  if (!found) return null;
  if (found.expiresAt <= Date.now()) {
    store.attestations.delete(address.toLowerCase());
    return null;
  }
  return found;
}

export type SaveResult = { ok: true } | { ok: false; reason: string };

/**
 * Record Lend's own conclusion.
 *
 * The nullifier index is the sybil control on this axis: World's RP-scoped nullifier is stable per
 * document per relying party, so one passport cannot attest for two wallets and draw two Starter
 * loans. Standing already resists that differently; this closes the identity-shaped hole.
 */
export function saveAttestation(attestation: IdentityAttestation): SaveResult {
  const address = attestation.address.toLowerCase();
  const owner = store.nullifiers.get(attestation.nullifier);
  if (owner && owner !== address) {
    return {
      ok: false,
      reason: "This ID has already been used to verify a different Lend account.",
    };
  }
  store.nullifiers.set(attestation.nullifier, address);
  store.attestations.set(address, { ...attestation, address });
  return { ok: true };
}
