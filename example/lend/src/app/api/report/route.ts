import { cookies } from "next/headers";
import { getAddress, isAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { ensureScoreRequest, fileReport, platformAddress, platformRegistered, PlatformConfigError, reportingConfigured } from "@/lib/platform";
import { recordReport, reportsAgainst } from "@/lib/reports";
import { isReasonCode } from "@/lib/reasons";
import { readVerifiedAddress } from "@/lib/session";
import { readStanding } from "@/lib/vouchme";

export const dynamic = "force-dynamic";
// Three serial waits live in this handler: the ScoreRequest receipt, VouchMe's attestation (which
// walks World Chain logs from the deployment block and is measured in tens of seconds, not
// milliseconds), and the filing broadcast. The platform default of 10s cuts that off mid-flight,
// after the ScoreRequest has already been paid for.
export const maxDuration = 60;

const ZERO_HASH: Hex = `0x${"00".repeat(32)}`;

/** VouchMe stores the enroll handle as the account's `ensName`, so `mallory.vouchme.eth`,
 *  `mallory.eth` and `mallory` all denote the same person. The suffix is stripped rather than
 *  required: it is how a person writes the name, not how the graph stores it. */
function toLookupId(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (isAddress(t)) return getAddress(t);
  return t.replace(/\.vouchme\.eth$/, "").replace(/\.eth$/, "");
}

/**
 * File a report against a person, on behalf of Lend, on chain.
 *
 * This is the one endpoint that spends Lend's bond. `ReportRegistry.file()` locks 10 VOUCHME per
 * weight point out of Lend's CredibilityVault position, and a jury that finds the accusation
 * MALICIOUS slashes it and voids Lend as a reporter permanently. So the order below refuses as
 * early and as cheaply as it can, and every refusal names the rule it comes from:
 *
 *   1. session          — Lend's bond is never spent for an anonymous caller
 *   2. body             — subject and a known reason code
 *   3. resolve subject  — a name via VouchMe, or a literal address
 *   4. subject exists   — you cannot report someone with no VouchMe account
 *   5. sanity           — not Lend itself, not the caller
 *   6. cooldown         — what Lend already knows, before the chain has to say it
 *   7. ScoreRequest     — the transparency-log entry that entitles Lend to report at all
 *   8. attestation      — VouchMe re-checks every rule against live chain state and signs
 *   9. file             — the transaction
 *
 * Step 8 is the real gate. Lend does not decide whether it may report; it asks, and VouchMe
 * answers from the chain. Every refusal from step 8 is passed through verbatim, because a
 * paraphrase of "your platform is below P1" is a worse message than the original.
 */
export async function POST(req: Request): Promise<Response> {
  // 1. Who is asking.
  const requestedBy = readVerifiedAddress(await cookies());
  if (!requestedBy) {
    return Response.json({ code: "not_signed_in", error: "Sign in with World to report someone." }, { status: 401 });
  }

  if (!reportingConfigured()) {
    return Response.json(
      {
        code: "not_configured",
        error:
          "Reporting is disabled: LEND_PLATFORM_PRIVATE_KEY is not set. Run scripts/seed-lendme-platform.mjs " +
          "and set the key it prints.",
      },
      { status: 503 },
    );
  }

  // 2. What was asked.
  let body: { subject?: unknown; reasonCode?: unknown; note?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ code: "bad_request", error: "Request body must be valid JSON." }, { status: 400 });
  }
  const subjectInput = typeof body.subject === "string" ? body.subject.trim() : "";
  if (!subjectInput) {
    return Response.json({ code: "bad_request", error: "Give an ENS name or an address to report." }, { status: 400 });
  }
  if (!isReasonCode(body.reasonCode)) {
    return Response.json({ code: "bad_reason", error: "Choose a reason for the report." }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";

  // 3 + 4. Resolve the subject through VouchMe. A name and an address take the same path, because
  //        the SDK matches an account on either.
  const lookupId = toLookupId(subjectInput);
  const { standing, unavailable } = await readStanding(lookupId);
  if (unavailable) {
    return Response.json({ code: "vouchme_unavailable", error: unavailable }, { status: 503 });
  }
  if (!standing) {
    const looksLikeName = !isAddress(lookupId);
    return Response.json(
      {
        code: "subject_not_found",
        error: looksLikeName
          ? `No VouchMe account resolves for "${subjectInput}". The name has to belong to someone enrolled — ` +
            `it is their enroll handle, not an ENS name registered elsewhere.`
          : `${subjectInput} has no VouchMe account, so there is no standing to report against.`,
      },
      { status: 404 },
    );
  }
  const target = getAddress(standing.address.toLowerCase()) as Address;

  // 5. Two refusals that are cheaper here than as a revert.
  const self = platformAddress();
  if (self && target.toLowerCase() === self.toLowerCase()) {
    return Response.json({ code: "self_report", error: "Lend cannot report itself." }, { status: 400 });
  }
  if (target.toLowerCase() === requestedBy.toLowerCase()) {
    return Response.json({ code: "self_report", error: "You cannot report yourself." }, { status: 400 });
  }

  if (!(await platformRegistered())) {
    return Response.json(
      {
        code: "platform_not_registered",
        error:
          "Lend is not a registered platform on this deployment, so it cannot report anyone. " +
          "Run scripts/seed-lendme-platform.mjs against the deployment this app points at.",
      },
      { status: 503 },
    );
  }

  // 6. Lend's own memory of a prior report against this person. The chain enforces a 180-day
  //    cooldown per (reporter, target); this only lets the refusal arrive without a reverted
  //    transaction, and is not the guarantee.
  const priors = reportsAgainst(target);
  const COOLDOWN_MS = 180 * 24 * 60 * 60 * 1000;
  const recent = priors.find((r) => Date.now() - r.at < COOLDOWN_MS);
  if (recent) {
    return Response.json(
      {
        code: "cooldown_active",
        error: `Lend already reported ${standing.ensName ?? target} on ${new Date(recent.at).toISOString().slice(0, 10)}. ` +
          `ReportRegistry enforces a 180-day cooldown per reporter/target pair.`,
        fileTxHash: recent.fileTxHash,
      },
      { status: 409 },
    );
  }

  const evidenceHash = note ? keccak256(toHex(note)) : ZERO_HASH;

  try {
    // 7. The attributed lookup that entitles Lend to report this subject (docs/12-reporting.md §2).
    //    Awaited, because step 8 checks the same mapping against live chain state.
    const { txHash: scoreRequestTxHash } = await ensureScoreRequest(target, `lend:report:${body.reasonCode}`);

    // 8. VouchMe re-checks every eligibility rule against the chain and signs the weight.
    const base = process.env.VOUCHME_API_URL ?? "http://localhost:3000";
    const attestRes = await fetch(`${base}/api/report/attest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reporter: self, target, evidenceHash }),
      cache: "no-store",
    });
    const attestBody = (await attestRes.json()) as {
      data?: { weightPoints: number; bondWei: string; deadline: string; nonce: string; attestation: Hex; reportRegistry: Address; evidenceHash: Hex };
      error?: { code?: string; message?: string };
    };
    if (!attestRes.ok || !attestBody.data) {
      // Passed through as-is. VouchMe's messages cite the contract line or doc section that refuses,
      // and nothing Lend could write here would be more useful than that.
      return Response.json(
        {
          code: attestBody.error?.code ?? "attestation_refused",
          error: attestBody.error?.message ?? "VouchMe refused to attest this report.",
        },
        { status: attestRes.status === 200 ? 502 : attestRes.status },
      );
    }

    // 9. File it.
    const data = attestBody.data;
    const fileTxHash = await fileReport({
      target,
      evidenceHash: data.evidenceHash ?? evidenceHash,
      weightPoints: Number(data.weightPoints),
      deadline: BigInt(data.deadline),
      nonce: BigInt(data.nonce),
      attestation: data.attestation,
      reportRegistry: data.reportRegistry,
    });

    recordReport({
      target,
      subjectInput,
      ensName: standing.ensName === standing.address ? null : standing.ensName,
      reasonCode: body.reasonCode,
      note,
      evidenceHash,
      weightPoints: Number(data.weightPoints),
      bondWei: data.bondWei,
      requestedBy,
      scoreRequestTxHash,
      fileTxHash,
      at: Date.now(),
    });

    return Response.json({
      target,
      ensName: standing.ensName === standing.address ? null : standing.ensName,
      scoreAtRisk: standing.scoreAtRisk,
      weightPoints: Number(data.weightPoints),
      bondWei: data.bondWei,
      scoreRequestTxHash,
      fileTxHash,
    });
  } catch (err) {
    if (err instanceof PlatformConfigError) {
      return Response.json({ code: "not_configured", error: err.message }, { status: 503 });
    }
    // A revert here is worth surfacing verbatim: `NoScoreRequest`, `CooldownActive`,
    // `InsufficientAvailable` and `BadAttestation` each mean something specific and different.
    const message = err instanceof Error ? (("shortMessage" in err && typeof err.shortMessage === "string" ? err.shortMessage : err.message)) : String(err);
    return Response.json({ code: "file_failed", error: message }, { status: 502 });
  }
}
