import { createVouchMe, VouchMeError, type Standing } from "@vouchme/minikit-sdk";

/**
 * The entire VouchMe integration, in one file.
 *
 * Everything here runs on Lend's server, never in the browser. Not for secrecy — every one of these
 * reads is public and unauthenticated — but because eligibility is a server's job. A gate evaluated
 * in the client is a gate the client can edit.
 */

const BASE_URL = process.env.VOUCHME_API_URL ?? "http://localhost:3000";

/** 4s suits a Subgraph-backed deployment. VouchMe's live mode walks World Chain logs per request
 *  and answers in ~33s, so a short timeout there turns every read into "VouchMe is unreachable". */
const TIMEOUT_MS = Number(process.env.VOUCHME_TIMEOUT_MS ?? 4_000);

const vouchme = createVouchMe({ baseUrl: BASE_URL, timeoutMs: TIMEOUT_MS });

export { VouchMeError };
export type { Standing };

export interface Reading {
  standing: Standing | null;
  /** Set when VouchMe could not be reached at all. Distinct from `standing: null`, which means
   *  VouchMe answered and the person simply has no account. Conflating the two would let an outage
   *  read as "nobody has any standing" — harmless here, since both deny — but the claim route needs
   *  to tell a refusal apart from an outage so it can say which happened. */
  unavailable: string | null;
}

export async function readStanding(idOrAddress: string | null): Promise<Reading> {
  if (!idOrAddress) return { standing: null, unavailable: null };
  try {
    return { standing: await vouchme.standing(idOrAddress), unavailable: null };
  } catch (err) {
    return {
      standing: null,
      unavailable: err instanceof VouchMeError ? err.message : "VouchMe is unreachable.",
    };
  }
}
