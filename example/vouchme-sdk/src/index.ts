/**
 * @vouchme/minikit-sdk — the whole third-party integration surface.
 *
 * A World App mini app already knows its user's wallet address (MiniKit `walletAuth`). That address
 * is the only join key VouchMe needs, so reading someone's standing is one unauthenticated GET.
 * There is no API key, no OAuth, no consent handshake, and no on-chain call from the integrator.
 *
 * WHAT THIS DELIBERATELY CANNOT DO
 * --------------------------------
 * There is no `vouch()` here and there never will be (docs/06-mcp-skills.md §3). Creating trust
 * requires a present human inside the VouchMe app. A third party may only ever *read*.
 *
 * PROVENANCE IS NOT OPTIONAL
 * --------------------------
 * Every VouchMe response carries `meta.subgraphDeployment` + `meta.computedAtBlock`
 * (docs/07-app-api.md §3). This SDK keeps `meta` attached to every result rather than unwrapping
 * the envelope, because an integrator that shows a person a price derived from their reputation
 * should be able to show them where the number came from.
 */

export type Tier = 0 | 1 | 2;

/** The envelope every VouchMe route responds with. */
export interface VouchMeMeta {
  subgraphDeployment: string;
  computedAtBlock: number;
  indexerLagBlocks: number;
  engineVersion: string;
  mode: "live" | "fixture";
  chainId?: number;
}

/**
 * A deliberately narrow projection of VouchMe's `ScoreResult`. The full response carries the
 * per-edge breakdown, the presence drip, the weakest link and the promotion gates; a third party
 * pricing a rental needs none of that, and typing the parts it does not use would invite it to
 * start depending on them.
 */
export interface Standing {
  address: string;
  ensName: string;
  /** An anchor's score is administratively fixed at 100 and ignores every inbound vouch (FR-2), so
   *  it sits BELOW the Tier 2 threshold of 140 and can never climb. Any integrator scaling a
   *  benefit across the score range has to special-case that, or it ends up charging the strongest
   *  credential in the system more than a well-vouched member. */
  kind: "anchor" | "member" | "platform";
  /** Enrollment floor for this account. Read live rather than assumed: an Orb anchor's floor is
   *  100, not 20, so a discount curve anchored on a hardcoded base misprices anchors. */
  base: number;
  /** Published score — already floored at `base + tenure` and net of upheld reports. */
  score: number;
  /** What the score becomes if every pending report against them is upheld. Lower than `score`
   *  whenever an accusation is open. Price with this if you are the one taking the risk. */
  scoreAtRisk: number;
  tier: Tier;
  /** Hops to the nearest origin, or null when unreachable from any anchor. */
  depth: number | null;
  credentialStatus: "active" | "grace" | "suspended";
  credentialExpiresAt: string;
  meta: VouchMeMeta;
}

export interface GatePolicy {
  minTier?: Tier;
  minScore?: number;
  /** Price pending accusations in as though they were upheld. */
  usePendingReports?: boolean;
  requireCredential?: "orb" | "selfie" | "document";
}

export interface GateDecision {
  allow: boolean;
  /** Never empty on a refusal. Show these to the person — a bare "denied" is not a product. */
  reasons: string[];
  meta: VouchMeMeta;
}

export interface Proximity {
  /**
   * Vouch hops between the two accounts: 1 if either vouches the other, 2 if somebody vouches for
   * both, null beyond that.
   *
   * Capped at 2 on purpose. Anything further needs a full traversal, and "three degrees of
   * separation" is not a claim a person can check, which makes it useless as the basis of a
   * discount you have to justify to them.
   */
  hops: number | null;
  /** Names of the people who vouch for both parties. Non-empty exactly when `hops` is 2, and the
   *  reason this read is worth doing: "Alice and Bob both vouch for each of you" is a sentence a
   *  human can act on, which a score is not. */
  sharedVouchers: string[];
  meta: VouchMeMeta;
}

export class VouchMeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VouchMeError";
  }
}

export interface VouchMeClientOptions {
  /** Base URL of a VouchMe deployment, e.g. https://vouchme.example. No trailing slash needed. */
  baseUrl: string;
  /** Inject a fetch implementation (tests, tracing, a proxy). Defaults to global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Abort a slow read rather than hanging a checkout screen. Default 5000ms. */
  timeoutMs?: number;
}

interface Envelope<T> {
  data: T;
  meta: VouchMeMeta;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
}

/** VouchMe's `ScoreResult`, of which `Standing` is a projection. Only the fields read here. */
interface RawScore {
  address: string;
  ensName: string;
  kind: "anchor" | "member" | "platform";
  base: number;
  score: number;
  scoreAtRisk: number;
  tier: number;
  depth: number | null;
  credentialStatus: "active" | "grace" | "suspended";
  credentialExpiresAt: string;
  breakdown: Array<{
    voucher: { address: string; ensName: string };
    /** <= 0 once the 90-day edge has lapsed. */
    daysUntilExpiry: number;
  }>;
}

export interface VouchMeClient {
  /**
   * Someone's current standing, or `null` if they have no VouchMe account at all.
   *
   * `null` is a normal, common answer — most of the world has not enrolled — so it is returned
   * rather than thrown. Treat it as "no reputation to price on", never as an error state.
   */
  standing(idOrAddress: string): Promise<Standing | null>;

  /** VouchMe's own gate check, with its reasons. Use this instead of comparing scores yourself:
   *  the promotion gates are score AND >=2 contributing vouchers AND a path to an origin, and
   *  score alone gets it wrong (docs/06-mcp-skills.md §2.4). */
  gate(address: string, policy?: GatePolicy): Promise<GateDecision>;

  /**
   * How close two accounts are in the vouch graph.
   *
   * This is the read no other personhood system can answer: a nullifier has no neighbours. Use it
   * for "Alice vouches for both of you" — a sentence that means something to a human in a way a
   * score does not.
   *
   * Costs two `/api/score` reads and does the comparison locally, because VouchMe's `/api/path`
   * walks toward an anchor rather than between two arbitrary accounts.
   */
  proximity(from: string, to: string): Promise<Proximity>;
}

const DEFAULT_TIMEOUT_MS = 5_000;

function toTier(value: number): Tier {
  return value >= 2 ? 2 : value >= 1 ? 1 : 0;
}

/** An account is identified by an ENS name OR an address depending on who is asking, so both are
 *  matchable. Lowercased because address casing is EIP-55 display, not identity. */
function identityKeys(ensName: string, address: string): string[] {
  return [ensName.toLowerCase(), address.toLowerCase()];
}

export function createVouchMe(options: VouchMeClientOptions): VouchMeClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * One retry, and only for a transport failure — a timeout or an unreachable host.
   *
   * Never retried: any HTTP status. A 404 or a 500 is an ANSWER, and repeating the question does
   * not change it. Only the cases where no answer arrived are worth asking twice.
   *
   * This exists because failing closed here is not free. A transient timeout makes `standing()`
   * throw, the caller prices the user as if they had no reputation, and the person silently pays
   * the full amount for a read that merely arrived late. Observed in practice: the suite flaked at
   * roughly one run in three against a dev server whose route compile outran the 4s default.
   */
  async function request<T>(path: string, init?: RequestInit): Promise<Envelope<T>> {
    try {
      return await attempt<T>(path, init);
    } catch (err) {
      const transport = err instanceof VouchMeError && (err.code === "timeout" || err.code === "unreachable");
      if (!transport) throw err;
      return await attempt<T>(path, init);
    }
  }

  async function attempt<T>(path: string, init?: RequestInit): Promise<Envelope<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: { accept: "application/json", ...(init?.headers ?? {}) },
        // Reputation is revocable in one tap and takes effect on the next read, so a cached
        // verdict is a wrong verdict (docs/06-mcp-skills.md §4.1 "never cache beyond 5 minutes").
        cache: "no-store",
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new VouchMeError(
        0,
        aborted ? "timeout" : "unreachable",
        aborted ? `VouchMe did not answer within ${timeoutMs}ms.` : `Could not reach VouchMe at ${baseUrl}.`,
      );
    } finally {
      clearTimeout(timer);
    }

    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const e = (body as ErrorEnvelope | null)?.error;
      throw new VouchMeError(response.status, e?.code ?? "http_error", e?.message ?? `VouchMe returned ${response.status}.`);
    }
    return body as Envelope<T>;
  }

  /** `null` on 404 — "not enrolled" is an answer about the world, not a failure of the call. */
  async function fetchScore(idOrAddress: string): Promise<Envelope<RawScore> | null> {
    try {
      return await request<RawScore>(`/api/score/${encodeURIComponent(idOrAddress)}`);
    } catch (err) {
      if (err instanceof VouchMeError && err.status === 404) return null;
      throw err;
    }
  }

  return {
    async standing(idOrAddress) {
      const envelope = await fetchScore(idOrAddress);
      if (!envelope) return null;
      const d = envelope.data;
      return {
        address: d.address,
        ensName: d.ensName,
        kind: d.kind,
        base: d.base,
        score: d.score,
        scoreAtRisk: d.scoreAtRisk,
        tier: toTier(d.tier),
        depth: d.depth,
        credentialStatus: d.credentialStatus,
        credentialExpiresAt: d.credentialExpiresAt,
        meta: envelope.meta,
      };
    },

    async gate(address, policy = {}) {
      const envelope = await request<{ allow: boolean; reasons: string[] }>("/api/gate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, policy }),
      });
      return { allow: envelope.data.allow, reasons: envelope.data.reasons, meta: envelope.meta };
    },

    async proximity(from, to) {
      const [a, b] = await Promise.all([fetchScore(from), fetchScore(to)]);
      // Whichever read succeeded still carries real provenance; fall back to the other's only if
      // it has to.
      const meta = a?.meta ?? b?.meta;
      if (!a || !b || !meta) {
        return {
          hops: null,
          sharedVouchers: [],
          meta: meta ?? {
            subgraphDeployment: "unavailable",
            computedAtBlock: 0,
            indexerLagBlocks: 0,
            engineVersion: "unknown",
            mode: "live",
          },
        };
      }

      // An expired edge is not a relationship. `counted` is deliberately NOT the filter here: a
      // vouch excluded from the score by the depth-ordering rule is still someone who really did
      // vouch, and for "do you two know each other" that is exactly the fact being asked about.
      const activeVouchers = (score: RawScore) =>
        score.breakdown.filter((row) => row.daysUntilExpiry > 0).map((row) => row.voucher);

      const aVouchers = activeVouchers(a.data);
      const bVouchers = activeVouchers(b.data);
      const aKeys = new Set(identityKeys(a.data.ensName, a.data.address));
      const bKeys = new Set(identityKeys(b.data.ensName, b.data.address));

      const directEdge =
        aVouchers.some((v) => identityKeys(v.ensName, v.address).some((k) => bKeys.has(k))) ||
        bVouchers.some((v) => identityKeys(v.ensName, v.address).some((k) => aKeys.has(k)));
      if (directEdge) return { hops: 1, sharedVouchers: [], meta };

      const bVoucherKeys = new Set(bVouchers.flatMap((v) => identityKeys(v.ensName, v.address)));
      const shared = aVouchers
        .filter((v) => identityKeys(v.ensName, v.address).some((k) => bVoucherKeys.has(k)))
        .map((v) => v.ensName);
      if (shared.length > 0) return { hops: 2, sharedVouchers: shared, meta };

      return { hops: null, sharedVouchers: [], meta };
    },
  };
}
