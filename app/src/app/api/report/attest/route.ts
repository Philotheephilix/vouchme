/**
 * POST /api/report/attest
 *
 * Signs the EIP-712 `ReportAttestation` that `ReportRegistry.file()` demands, for exactly the same
 * reason `AvalRegistry.vouch` demands one for `voucherTier`: **report weight is a whole-graph
 * property the EVM must not compute** (docs/12-reporting.md §5). The contract records the number;
 * the engine independently re-derives it at read time and credits `min(snapshotWeight, live
 * weight)` (docs/01-trust-math.md §7.1), so a forged weight buys a report the recompute will not
 * honour — the failure is contained, but this server still refuses to be the one forging it.
 *
 * What this route enforces before signing, and where each rule comes from:
 *
 * | Rule | Source | Failure |
 * |---|---|---|
 * | reporter is an enrolled human **or** a registered platform | ReportRegistry.sol:175-182 | 409 |
 * | human reporter has tier ≥ 1 | docs/12-reporting.md §2 | 403 |
 * | human reporter is within 2 hops of a human target | docs/12-reporting.md §2 | 403 |
 * | platform reporter has tier ≥ P1 | docs/12-reporting.md §2 | 403 |
 * | platform reporter has a prior `ScoreRequest` for the subject | ReportRegistry.sol:178, docs/13-platforms.md §5 | 409 |
 * | reporter is not `voided` by a MALICIOUS verdict | ReportRegistry.sol:172 | 403 |
 * | reporter is under its concurrent-open-report cap | docs/12-reporting.md §2.1 | 409 |
 * | 180-day same-pair cooldown has elapsed | ReportRegistry.sol:188 | 409 |
 * | the computed weight is > 0 | ReportRegistry.sol:173 (`ZeroWeight`) | 422 |
 * | the attestor key is allow-listed on the deployed registry | ReportRegistry.sol:386 | 503 |
 *
 * Everything above the line is checked against LIVE chain state, not against a cached view, and
 * every one of them corresponds to a revert the transaction would hit anyway. Signing first and
 * letting the chain refuse would burn a single-use attestation and tell the person their
 * accusation had been accepted when it had not.
 *
 * NOT checked here, deliberately: whether the accusation is TRUE. Nothing in this system decides
 * that — the target's vouchers do, over the next 72 hours (docs/12-reporting.md §3).
 */

import "server-only";

import { isAddress, getAddress, isHex, type Address, type Hex } from "viem";
import { weightNeg } from "@aval/engine";
import {
  AttestorConfigError,
  deadlineFromNow,
  getAttestorAddress,
  randomNonce,
  signReportAttestation,
} from "@/lib/attestation";
import {
  getLiveGraph,
  getReportRegistryAddressServer,
  getReporterChainState,
  hasScoreRequest,
  isRegisteredPlatform,
} from "@/lib/chain";
import { isJsonObject, ok, fail, FALLBACK_META } from "@/app/api/_lib/respond";

export const dynamic = "force-dynamic";

interface ReportAttestRequestBody {
  reporter?: string;
  target?: string;
  /** IPFS CID hash of the evidence; content stays off-chain (docs/12-reporting.md §5). Optional —
   *  a report with no evidence is a weaker report, not an invalid one, and the contract accepts
   *  `bytes32(0)`. This route never invents one. */
  evidenceHash?: string;
}

/** docs/12-reporting.md §2.1: humans may hold exactly one open report at a time — "a human with one
 *  open report at a time cannot brigade". Mirrors `HUMAN_CONCURRENT_CAP` (ReportRegistry.sol:67). */
const HUMAN_CONCURRENT_CAP = 1;

/** `SAME_PAIR_COOLDOWN` (ReportRegistry.sol:64) — 180 days between reports on the same pair. */
const SAME_PAIR_COOLDOWN_SECONDS = 180 * 24 * 60 * 60;

/** `bond / 1 000 AVAL`, clamped to [1, 50] — `PlatformRegistry.reportLimitOf` (PlatformRegistry
 *  .sol:314), recomputed here from the bond this module already read rather than paying for a
 *  second RPC round trip to learn a pure function of it. */
function platformReportLimit(bondWei: bigint): number {
  const limit = Number(bondWei / BigInt(1_000) / BigInt(10) ** BigInt(18));
  return Math.min(50, Math.max(1, limit));
}

/** True if `target` is within 2 hops of `reporter` over ACTIVE vouch edges, in either direction.
 *
 *  docs/12-reporting.md §2: a human may only report someone they have a connection to — "you cannot
 *  report a stranger you have never dealt with." Direction is deliberately ignored: being vouched
 *  FOR by someone is exactly as much of a relationship as vouching for them, and the doc's "within
 *  2 hops in the trust graph" says hops, not arrows. */
function withinTwoHops(reporter: string, target: string, vouches: ReadonlyArray<{ voucher: string; vouchee: string; active: boolean }>): boolean {
  const neighbours = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    neighbours.get(a)!.add(b);
  };
  for (const v of vouches) {
    if (!v.active) continue;
    link(v.voucher, v.vouchee);
    link(v.vouchee, v.voucher);
  }
  const first = neighbours.get(reporter) ?? new Set<string>();
  if (first.has(target)) return true;
  for (const mid of first) {
    if ((neighbours.get(mid) ?? new Set<string>()).has(target)) return true;
  }
  return false;
}

export async function POST(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!isJsonObject(parsed)) return fail(400, "invalid_body", "Request body must be a JSON object.");
  const body = parsed as ReportAttestRequestBody;

  if (!body.reporter || !isAddress(body.reporter)) return fail(400, "invalid_reporter", "`reporter` must be a valid address.");
  if (!body.target || !isAddress(body.target)) return fail(400, "invalid_target", "`target` must be a valid address.");
  const reporter = getAddress(body.reporter);
  const target = getAddress(body.target);
  if (reporter.toLowerCase() === target.toLowerCase()) {
    return fail(400, "self_report", "You cannot report yourself.");
  }

  let evidenceHash: Hex = `0x${"0".repeat(64)}`;
  if (body.evidenceHash !== undefined) {
    if (!isHex(body.evidenceHash) || body.evidenceHash.length !== 66) {
      return fail(400, "invalid_evidence_hash", "`evidenceHash` must be a 32-byte hex string.");
    }
    evidenceHash = body.evidenceHash;
  }

  const registry = getReportRegistryAddressServer();
  if (!registry) {
    return fail(503, "reports_not_configured", "REPORT_REGISTRY_ADDRESS is not set on this server, so reports cannot be filed.");
  }

  let attestor: Address;
  try {
    attestor = getAttestorAddress();
  } catch (err) {
    return fail(503, "attestor_unavailable", err instanceof Error ? err.message : "No attestor key is configured.");
  }

  const graph = await getLiveGraph();
  const output = graph.engineOutput;

  const reporterIsPlatform = graph.platforms.get(reporter)?.active === true || (await isRegisteredPlatform(reporter));
  const reporterIsHuman = graph.members.get(reporter)?.enrolled === true;
  if (!reporterIsPlatform && !reporterIsHuman) {
    return fail(409, "reporter_not_enrolled", "The reporting account is neither an enrolled human nor a registered platform.");
  }

  const targetIsPlatform = graph.platforms.get(target)?.active === true;
  const targetIsHuman = graph.members.get(target)?.enrolled === true;
  if (!targetIsPlatform && !targetIsHuman) {
    return fail(409, "target_not_enrolled", "The account being reported is neither enrolled nor a registered platform.");
  }

  const chainState = await getReporterChainState(reporter, target, attestor);
  if (!chainState.attestorEnabled) {
    return fail(
      503,
      "attestor_not_wired",
      `ReportRegistry ${registry} does not allow-list this server's attestor (${attestor}). ` +
        "Until the governor calls setAttestor, every filed report would revert with BadAttestation.",
    );
  }
  if (chainState.voided) {
    return fail(403, "reporter_voided", "A MALICIOUS verdict has voided this account's reports; it cannot file another.");
  }
  if (chainState.lastReportAt !== 0 && graph.now < chainState.lastReportAt + SAME_PAIR_COOLDOWN_SECONDS) {
    const until = new Date((chainState.lastReportAt + SAME_PAIR_COOLDOWN_SECONDS) * 1000).toISOString();
    return fail(409, "cooldown_active", `This account already reported this target. The 180-day same-pair cooldown runs until ${until}.`);
  }

  // ── weight, and the eligibility rules that differ by reporter kind ─────────────────────────────
  let weightPoints: number;
  if (reporterIsPlatform) {
    const platformTier = output.platformTier[reporter] ?? 0;
    if (platformTier < 1) {
      return fail(
        403,
        "insufficient_platform_tier",
        "docs/12-reporting.md §2: a platform needs tier ≥ P1 (40.00) to report. This platform is P0.",
      );
    }
    if (!(await hasScoreRequest(reporter, target))) {
      return fail(
        409,
        "no_score_request",
        "A platform may only report a subject it has previously queried through an attributed ScoreRequest " +
          "(docs/13-platforms.md §5). ReportRegistry.file() would revert with NoScoreRequest().",
      );
    }
    const bond = graph.platforms.get(reporter)?.bond ?? BigInt(0);
    if (chainState.openReportCount >= platformReportLimit(bond)) {
      return fail(409, "too_many_open_reports", `This platform's bond buys ${platformReportLimit(bond)} concurrent open reports, and they are all in use.`);
    }
    weightPoints = weightNeg(output.sPlatform[reporter] ?? 0);
  } else {
    const tier = output.tier[reporter] ?? 0;
    if (tier < 1) {
      return fail(
        403,
        "insufficient_tier",
        "docs/12-reporting.md §2: a human needs tier ≥ 1 to report. Tier 0 accounts cannot file reports.",
      );
    }
    if (targetIsHuman && !withinTwoHops(reporter, target, graph.engineInput.vouches)) {
      return fail(
        403,
        "no_connection",
        "docs/12-reporting.md §2: you can only report someone you have a connection to — within 2 hops " +
          "in the trust graph. You cannot report a stranger you have never dealt with.",
      );
    }
    if (chainState.openReportCount >= HUMAN_CONCURRENT_CAP) {
      return fail(409, "too_many_open_reports", "A human may hold only one open report at a time (docs/12-reporting.md §2.1).");
    }
    weightPoints = weightNeg(output.score[reporter] ?? 0);
  }

  if (weightPoints <= 0) {
    return fail(
      422,
      "zero_weight",
      "This account's report would carry zero weight, and ReportRegistry.file() rejects a zero-weight report.",
    );
  }

  const deadline = deadlineFromNow();
  const nonce = randomNonce();

  let attestation: Hex;
  try {
    attestation = await signReportAttestation({ reporter, target, weightPoints, deadline, nonce });
  } catch (err) {
    const status = err instanceof AttestorConfigError ? 503 : 500;
    return fail(status, "attestation_failed", err instanceof Error ? err.message : "Failed to sign the report attestation.");
  }

  return ok(
    {
      reporter,
      target,
      evidenceHash,
      weightPoints,
      /** `BOND_PER_WEIGHT × weightPoints` (ReportRegistry.sol:65) — AVAL wei the reporter must
       *  already have bonded in CredibilityVault, or `file()` reverts with InsufficientAvailable. */
      bondWei: (BigInt(weightPoints) * BigInt("10000000000000000000")).toString(),
      deadline: deadline.toString(),
      nonce: nonce.toString(),
      attestation,
      reportRegistry: registry,
    },
    FALLBACK_META,
  );
}
