/**
 * app/src/lib/authSession.ts
 *
 * Server-side sign-in: a real EIP-191 `personal_sign` over a server-issued, single-use, expiring
 * nonce, verified server-side with viem's `verifyMessage`, and only then a session — bound to the
 * verified address by an HMAC signature the client cannot forge or edit. `vouchme_session` (httpOnly)
 * is that session, and the only cookie any server page trusts for authorization.
 *
 * `vouchme_addr` is written (mirrored) alongside it, plain and client-writable, because
 * src/lib/session.tsx reads it client-side to restore UI state without a round trip on load. It is
 * display-only: nothing that grants access to another member's data in Home, Reports or Profile
 * trusts it.
 *
 * Nonce pattern deliberately mirrors src/app/api/enroll/rp-context/route.ts: a nonce + issuedAt +
 * expiresAt signed server-side with the same secret this deployment already provisions
 * (ATTESTOR_PRIVATE_KEY — the only server secret this deployment has; rp-context reuses it for the
 * same reason, see that file's doc comment) so the token is self-verifying and tamper-evident. A
 * small in-memory consumed-set enforces single-use on top of that: this deployment is one
 * long-running process, so that is sufficient, and it resets on restart, which only means old
 * nonces stop being redeemable, never the reverse.
 */

import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { createPublicClient, getAddress, http, type PublicClient } from "viem";
import type { Address } from "@/lib/types";
import { buildSignInMessage as buildSignInMessageShared } from "@/lib/signInMessage";

/** Chain used solely to answer ERC-1271/6492 signature questions — see `verifyWalletSignature`.
 *  Deliberately its own tiny client rather than `chain.ts`'s: that one is configured for log
 *  scanning and multicall batching, and signature checks must keep working even if the data layer
 *  is misconfigured. Reads the same env so it can never point at a different chain than the app. */
let verificationClient: PublicClient | null = null;

function getVerificationClient(): PublicClient {
  if (verificationClient) return verificationClient;
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "480");
  const rpcUrl =
    process.env.WORLDCHAIN_RPC ??
    process.env.NEXT_PUBLIC_WORLDCHAIN_RPC ??
    "https://worldchain-mainnet.g.alchemy.com/public";
  verificationClient = createPublicClient({
    chain: {
      id: chainId,
      name: chainId === 480 ? "World Chain" : "World Chain Sepolia",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    },
    transport: http(rpcUrl),
  }) as PublicClient;
  return verificationClient;
}

export class AuthConfigError extends Error {}

export const SESSION_COOKIE = "vouchme_session";
export const LEGACY_ADDR_COOKIE = "vouchme_addr";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — the vouchme_addr mirror in session.tsx must match.
const NONCE_TTL_SECONDS = 5 * 60; // short-lived, same order as ATTESTATION_TTL_SECONDS.

function getSecret(): string {
  const key = process.env.ATTESTOR_PRIVATE_KEY;
  if (!key) {
    throw new AuthConfigError(
      "ATTESTOR_PRIVATE_KEY is not set. This server cannot issue or verify sign-in nonces/sessions without it.",
    );
  }
  return key;
}

function hmacHex(purpose: string, payload: string): string {
  return createHmac("sha256", `${getSecret()}:${purpose}`).update(payload).digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ─── Sign-in nonce — self-verifying (HMAC-signed, expiring) + a consumed-set for single-use ──────

export interface NonceToken {
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  sig: string;
}

const consumedNonces = new Map<string, number>(); // nonce -> its own expiresAt, so it can be swept once stale.

function sweepConsumedNonces(now: number): void {
  for (const [nonce, expiresAt] of consumedNonces) {
    if (expiresAt < now) consumedNonces.delete(nonce);
  }
}

export function issueNonce(): NonceToken {
  // 16 random bytes as hex: 32 chars, alphanumeric — also satisfies MiniKit's "alphanumeric,
  // at least 8 chars" nonce requirement, in case a caller wants to reuse this for that path too.
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + NONCE_TTL_SECONDS;
  const sig = hmacHex("nonce", `${nonce}.${issuedAt}.${expiresAt}`);
  return { nonce, issuedAt, expiresAt, sig };
}

export type ConsumeNonceResult = { ok: true; nonce: NonceToken } | { ok: false; reason: string };

function isNonceTokenShape(value: unknown): value is NonceToken {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.nonce === "string" && typeof v.issuedAt === "number" && typeof v.expiresAt === "number" && typeof v.sig === "string";
}

/** Verifies the token is one *we* issued, unexpired, and not already redeemed — then marks it
 *  redeemed. Call once per sign-in attempt, before checking the wallet signature, so a burned
 *  nonce can't be retried even when the signature check that follows it fails. */
export function consumeNonce(token: unknown): ConsumeNonceResult {
  if (!isNonceTokenShape(token)) return { ok: false, reason: "Malformed nonce." };
  const { nonce, issuedAt, expiresAt, sig } = token;
  const now = Math.floor(Date.now() / 1000);
  sweepConsumedNonces(now);

  const expectedSig = hmacHex("nonce", `${nonce}.${issuedAt}.${expiresAt}`);
  if (!timingSafeEqualHex(sig, expectedSig)) return { ok: false, reason: "Invalid nonce." };
  if (now > expiresAt) return { ok: false, reason: "Nonce expired." };
  if (consumedNonces.has(nonce)) return { ok: false, reason: "Nonce already used." };

  consumedNonces.set(nonce, expiresAt);
  return { ok: true, nonce: token };
}

// ─── Sign-in message (EIP-191 personal_sign, injected-wallet path) ───────────────────────────────

/** Re-exported for route handlers — see src/lib/signInMessage.ts (shared with the client, which is
 *  why the actual formatting lives there rather than in this server-only module). */
export function buildSignInMessage(address: Address, nonce: NonceToken): string {
  return buildSignInMessageShared(address, nonce.nonce, nonce.issuedAt, nonce.expiresAt);
}

/**
 * The one place a claimed (address, message, signature) triple becomes "yes, this address really
 * produced this signature". Never trust an address without this returning true.
 *
 * Two verification schemes, because there are two kinds of signer and World App is the second:
 *
 *  1. **EOA** — `ecrecover` over the EIP-191 digest, which viem's pure `verifyMessage` does.
 *  2. **Smart contract account (ERC-1271)** — the signature is validated by *calling the account
 *     contract*, which has its own rules. Nothing can be recovered from it; `ecrecover` returns
 *     some unrelated address and verification fails.
 *
 * World App wallets are smart contract accounts, so `walletAuth` signatures are ERC-1271 and an
 * EOA-only check rejects them even though they are perfectly valid.
 *
 * The public-client `verifyMessage` action handles both: it tries EOA recovery, then falls back to
 * an on-chain ERC-1271 `isValidSignature` call (and ERC-6492 for accounts not yet deployed, which
 * matters because a World App user's account may be counterfactual until their first transaction).
 * That fallback needs a chain to call, hence the client.
 *
 * Fails closed: any error, including an unreachable RPC, returns false rather than admitting an
 * unverified address.
 */
export async function verifyWalletSignature(address: Address, message: string, signature: `0x${string}`): Promise<boolean> {
  try {
    return await getVerificationClient().verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
}

// ─── Session cookie — httpOnly, HMAC-bound to the verified address ───────────────────────────────

interface SessionPayload {
  address: Address;
  exp: number;
}

function signSession(payload: SessionPayload): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${hmacHex("session", body)}`;
}

function verifySessionValue(value: string | undefined): Address | null {
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const body = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  let expectedSig: string;
  try {
    expectedSig = hmacHex("session", body);
  } catch {
    return null; // ATTESTOR_PRIVATE_KEY not configured — fail closed, never trust an unverifiable cookie.
  }
  if (!timingSafeEqualHex(sig, expectedSig)) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.address !== "string" || typeof payload.exp !== "number") return null;
  if (Math.floor(Date.now() / 1000) > payload.exp) return null;
  try {
    return getAddress(payload.address) as Address;
  } catch {
    return null;
  }
}

export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/** The one function every server page/route calls to find out who's signed in.
 *  Cryptographically verifies `vouchme_session`; never reads `vouchme_addr` for this purpose. Returns
 *  null for missing, forged, tampered, expired or malformed sessions — callers then behave exactly
 *  as if signed out. */
export function readVerifiedAddress(cookieStore: CookieReader): Address | null {
  return verifySessionValue(cookieStore.get(SESSION_COOKIE)?.value);
}

export interface CookieWriter {
  set(name: string, value: string, options?: Record<string, unknown>): void;
}

/** Mints a verified session — call only after `verifyWalletSignature` returned true. Sets the
 *  httpOnly, signed `vouchme_session` cookie (the only one trusted for authorization) and mirrors the
 *  plain `vouchme_addr` cookie (unauthenticated, UI-only — see file doc comment). */
export function setSessionCookies(res: CookieWriter, address: Address, secure: boolean): void {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const value = signSession({ address, exp });
  res.set(SESSION_COOKIE, value, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: SESSION_TTL_SECONDS });
  res.set(LEGACY_ADDR_COOKIE, address, { httpOnly: false, secure, sameSite: "lax", path: "/", maxAge: SESSION_TTL_SECONDS });
}

export function clearSessionCookies(res: CookieWriter, secure: boolean): void {
  res.set(SESSION_COOKIE, "", { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 0 });
  res.set(LEGACY_ADDR_COOKIE, "", { httpOnly: false, secure, sameSite: "lax", path: "/", maxAge: 0 });
}
