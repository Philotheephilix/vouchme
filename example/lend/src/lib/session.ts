/**
 * Server-side sign-in for Lend.
 *
 * Reading a VouchMe score needs no authentication — scores are public. Sign-in exists for exactly
 * one reason: Lend sends money TO an address, so it must know the person holding the phone controls
 * the address whose standing unlocked the pool. Otherwise anyone types an anchor's address and
 * drains the treasury.
 *
 * Three things have to hold, and each has its own failure mode:
 *
 *  1. **The signature is real.** World App wallets are smart contract accounts, so `walletAuth`
 *     signatures are ERC-1271 — validated by calling the account contract, not by `ecrecover`. An
 *     EOA-only check rejects every genuine World App user.
 *  2. **It was made for this request.** A server-issued, HMAC-signed, expiring, single-use nonce.
 *     Without it a signature captured once is a permanent password.
 *  3. **The session cannot be edited.** The cookie is httpOnly and HMAC-bound to the verified
 *     address, so a client that rewrites it invalidates it.
 *
 * Lifted almost verbatim from Fiar's `src/lib/session.ts`, which mirrors VouchMe's own
 * `app/src/lib/authSession.ts`. An integrator copying this file should end up with the same
 * guarantees the protocol's own app has, not a weaker imitation.
 */

import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { createPublicClient, getAddress, http, type PublicClient } from "viem";

export type Address = `0x${string}`;

export const SESSION_COOKIE = "lend_session";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;
const NONCE_TTL_SECONDS = 5 * 60;

export class AuthConfigError extends Error {}

function getSecret(): string {
  const key = process.env.LEND_SESSION_SECRET;
  if (!key || key.length < 16) {
    throw new AuthConfigError(
      "LEND_SESSION_SECRET is not set (or is shorter than 16 characters). Lend cannot issue or " +
        "verify sign-in nonces and sessions without it. Generate one with `openssl rand -hex 32`.",
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

// ─── nonce ───────────────────────────────────────────────────────────────────────────────────────

export interface NonceToken {
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  sig: string;
}

/**
 * nonce -> its own expiry, so the set can be swept rather than grown forever.
 *
 * Pinned to `globalThis` because Next gives each route handler its own module instance: a
 * module-level Map would let the same nonce be redeemed once per instance. Single-use is a security
 * property, and it must not depend on which handler happens to be loaded.
 *
 * A restart makes old nonces unredeemable, which is the safe direction. A multi-instance deployment
 * needs shared storage here.
 */
const nonceStore = globalThis as typeof globalThis & { __lendConsumedNonces?: Map<string, number> };
const consumedNonces: Map<string, number> = (nonceStore.__lendConsumedNonces ??= new Map());

export function issueNonce(): NonceToken {
  // 32 hex chars — also satisfies MiniKit's "alphanumeric, at least 8 characters" nonce rule, so
  // the same token can be handed straight to `walletAuth`.
  const nonce = randomBytes(16).toString("hex");
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + NONCE_TTL_SECONDS;
  return { nonce, issuedAt, expiresAt, sig: hmacHex("nonce", `${nonce}.${issuedAt}.${expiresAt}`) };
}

export type ConsumeNonceResult = { ok: true } | { ok: false; reason: string };

function isNonceToken(value: unknown): value is NonceToken {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.nonce === "string" &&
    typeof v.issuedAt === "number" &&
    typeof v.expiresAt === "number" &&
    typeof v.sig === "string"
  );
}

/**
 * Verifies the token is one this server issued, unexpired and unredeemed — then burns it.
 *
 * Called BEFORE the signature check, so a failed signature still consumes the nonce. Otherwise an
 * attacker retries the same challenge indefinitely while grinding at the signature.
 */
export function consumeNonce(token: unknown): ConsumeNonceResult {
  if (!isNonceToken(token)) return { ok: false, reason: "Malformed nonce." };
  const { nonce, issuedAt, expiresAt, sig } = token;
  const now = Math.floor(Date.now() / 1000);
  for (const [key, exp] of consumedNonces) if (exp < now) consumedNonces.delete(key);

  if (!timingSafeEqualHex(sig, hmacHex("nonce", `${nonce}.${issuedAt}.${expiresAt}`))) {
    return { ok: false, reason: "Invalid nonce." };
  }
  if (now > expiresAt) return { ok: false, reason: "Nonce expired. Try again." };
  if (consumedNonces.has(nonce)) return { ok: false, reason: "Nonce already used." };

  consumedNonces.set(nonce, expiresAt);
  return { ok: true };
}

// ─── signature ───────────────────────────────────────────────────────────────────────────────────

/** Its own tiny client rather than sharing one with the payout layer: signature checks must keep
 *  working even when everything else is misconfigured, and they must never silently point at a
 *  different chain than the one the wallet signed on. */
let verificationClient: PublicClient | null = null;

function getVerificationClient(): PublicClient {
  if (verificationClient) return verificationClient;
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "480");
  const rpcUrl = process.env.WORLDCHAIN_RPC ?? "https://worldchain-mainnet.g.alchemy.com/public";
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

/**
 * The one place a claimed (address, message, signature) triple becomes "this address really signed
 * this". Never trust an address without this returning true.
 *
 * The public-client action tries EOA recovery first, then falls back to an on-chain ERC-1271
 * `isValidSignature` call, and ERC-6492 for accounts not yet deployed — which matters because a
 * World App user's smart account may be counterfactual until their first transaction.
 *
 * Fails closed. An unreachable RPC returns false rather than admitting an unverified address.
 */
export async function verifyWalletSignature(
  address: Address,
  message: string,
  signature: `0x${string}`,
): Promise<boolean> {
  try {
    return await getVerificationClient().verifyMessage({ address, message, signature });
  } catch {
    return false;
  }
}

/**
 * Checks the SIWE message the wallet signed actually carries our nonce.
 *
 * Without this the signature is valid but meaningless: World App composes the SIWE message itself,
 * so a signature over *some* message from this address proves control of the key and nothing about
 * when. Requiring our single-use nonce inside the signed bytes is what binds it to this attempt.
 */
export function messageBindsNonce(message: string, nonce: string): boolean {
  return message.includes(nonce);
}

// ─── session cookie ──────────────────────────────────────────────────────────────────────────────

interface SessionPayload {
  address: Address;
  exp: number;
}

export function signSession(address: Address): { value: string; maxAge: number } {
  const payload: SessionPayload = {
    address,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return { value: `${body}.${hmacHex("session", body)}`, maxAge: SESSION_TTL_SECONDS };
}

export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/**
 * The only function any page or route calls to find out who is signed in.
 *
 * Returns null for missing, forged, tampered, expired or malformed sessions, and callers then
 * behave exactly as if signed out. There is no second path that trusts a cookie.
 */
export function readVerifiedAddress(cookies: CookieReader): Address | null {
  const value = cookies.get(SESSION_COOKIE)?.value;
  if (!value) return null;
  const dot = value.lastIndexOf(".");
  if (dot < 0) return null;
  const body = value.slice(0, dot);
  let expected: string;
  try {
    expected = hmacHex("session", body);
  } catch {
    return null; // secret not configured — fail closed rather than trust an unverifiable cookie
  }
  if (!timingSafeEqualHex(value.slice(dot + 1), expected)) return null;

  let payload: SessionPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SessionPayload;
  } catch {
    return null;
  }
  if (typeof payload.address !== "string" || typeof payload.exp !== "number") return null;
  if (Math.floor(Date.now() / 1000) > payload.exp) return null;
  try {
    return getAddress(payload.address);
  } catch {
    return null;
  }
}
