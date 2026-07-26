import "server-only";

import type { PoolId } from "./pools";

/**
 * One claim per address per pool, ever.
 *
 * THIS RECORD IS IN MEMORY AND IS LOST ON RESTART. A restart re-opens every pool to every address
 * that already drew from it, and a second server process has its own empty copy. A real deployment
 * needs a database with a unique constraint on (address, pool) and the insert committed inside the
 * same transaction that records the transfer. This file is the shape of that, not a substitute.
 *
 * Pinned to `globalThis` because Next gives each route handler its own module instance: a
 * module-level Map would be written by the claim route and read as empty by the page, so a claim
 * would appear never to have happened. That is not a caching nuisance here, it is a double-spend.
 */

export interface ClaimRecord {
  address: string;
  pool: PoolId;
  amountWld: string;
  /** null while the transaction is still being submitted — the slot is taken from the instant the
   *  reservation is made, before any hash exists. */
  txHash: `0x${string}` | null;
  at: number;
}

const store = globalThis as typeof globalThis & { __lendClaims?: Map<string, ClaimRecord> };
const claims: Map<string, ClaimRecord> = (store.__lendClaims ??= new Map());

function key(address: string, pool: PoolId): string {
  return `${address.toLowerCase()}:${pool}`;
}

export function getClaim(address: string, pool: PoolId): ClaimRecord | null {
  return claims.get(key(address, pool)) ?? null;
}

export function claimsFor(address: string | null): Map<PoolId, ClaimRecord> {
  const found = new Map<PoolId, ClaimRecord>();
  if (!address) return found;
  const prefix = `${address.toLowerCase()}:`;
  for (const [k, record] of claims) if (k.startsWith(prefix)) found.set(record.pool, record);
  return found;
}

/**
 * Take the slot, or report who already holds it. Synchronous and awaitless by design: the check and
 * the write happen in one turn of the event loop, so two concurrent requests cannot both pass the
 * check. An `await` anywhere between them would reintroduce exactly the race this prevents.
 *
 * Called immediately BEFORE the transfer is submitted, so a slow confirmation can never be
 * double-spent by a second request arriving while the first is still waiting on the chain.
 */
export function reserve(address: string, pool: PoolId, amountWld: string): { ok: true } | { ok: false; existing: ClaimRecord } {
  const k = key(address, pool);
  const existing = claims.get(k);
  if (existing) return { ok: false, existing };
  claims.set(k, { address, pool, amountWld, txHash: null, at: Date.now() });
  return { ok: true };
}

/** Attach the hash to a reservation. Called the moment the transaction is broadcast, before the
 *  receipt is awaited — the record must not depend on a confirmation that may take a minute. */
export function recordHash(address: string, pool: PoolId, txHash: `0x${string}`): void {
  const record = claims.get(key(address, pool));
  if (record) record.txHash = txHash;
}

/** Give the slot back when the send never happened. Only ever called after a submission failure:
 *  a broadcast transaction, even one that later reverts, keeps its slot, because the safe failure
 *  is a user who must ask a human, not a treasury that pays twice. */
export function release(address: string, pool: PoolId): void {
  claims.delete(key(address, pool));
}
