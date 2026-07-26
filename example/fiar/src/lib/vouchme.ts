import { createVouchMe, VouchMeError, type Proximity, type Standing } from "@vouchme/minikit-sdk";
import type { Item } from "./policy";

/**
 * The entire VouchMe integration, in one file.
 *
 * Everything here runs on Fiar's server, never in the browser. Not for secrecy — every one of these
 * reads is public and unauthenticated — but because a price is a server's job. A quote assembled in
 * the client is a quote the client can edit.
 */

const BASE_URL = process.env.VOUCHME_API_URL ?? "http://localhost:3000";

const vouchme = createVouchMe({ baseUrl: BASE_URL, timeoutMs: 4_000 });

export { VouchMeError };
export type { Proximity, Standing };

export interface Reading {
  standing: Standing | null;
  /** Set when VouchMe could not be reached at all. Distinct from `standing: null`, which means
   *  VouchMe answered and the person simply has no account. Conflating the two would let an outage
   *  read as "nobody here has any reputation" and silently reprice the whole catalogue. */
  unavailable: string | null;
}

export async function readStanding(idOrAddress: string | null): Promise<Reading> {
  if (!idOrAddress) return { standing: null, unavailable: null };
  try {
    return { standing: await vouchme.standing(idOrAddress), unavailable: null };
  } catch (err) {
    return { standing: null, unavailable: err instanceof VouchMeError ? err.message : "VouchMe is unreachable." };
  }
}

export interface Closeness {
  hops: number;
  sharedVouchers: string[];
}

/**
 * How close the borrower is to each item's owner, keyed by item id.
 *
 * A missing key means "not connected, or we could not tell" — the caller treats both as no
 * discount, which is the safe direction: a failed proximity read never makes a rental cheaper than
 * it should be.
 */
export async function readProximity(borrower: string | null, items: Item[]): Promise<Map<string, Closeness>> {
  const byItem = new Map<string, Closeness>();
  if (!borrower) return byItem;
  const owners = [...new Set(items.map((item) => item.owner))];
  const results = await Promise.all(
    owners.map(async (owner): Promise<[string, Closeness | null]> => {
      try {
        const proximity: Proximity = await vouchme.proximity(borrower, owner);
        return [owner, proximity.hops === null ? null : { hops: proximity.hops, sharedVouchers: proximity.sharedVouchers }];
      } catch {
        return [owner, null];
      }
    }),
  );
  const byOwner = new Map(results);
  for (const item of items) {
    const value = byOwner.get(item.owner);
    if (value) byItem.set(item.id, value);
  }
  return byItem;
}
