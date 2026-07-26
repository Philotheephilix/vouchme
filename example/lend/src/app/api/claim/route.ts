import { cookies } from "next/headers";
import { getClaim, recordHash, release, reserve } from "@/lib/claims";
import { attestationSatisfies, identityLabel } from "@/lib/identity";
import { getAttestation } from "@/lib/identityStore";
import { findPool, qualifies, requirementLabel } from "@/lib/pools";
import { readVerifiedAddress } from "@/lib/session";
import { isPreBroadcast, sendWld } from "@/lib/treasury";
import { readStanding } from "@/lib/vouchme";

export const dynamic = "force-dynamic";

/**
 * The only endpoint that moves money.
 *
 * Everything the client sends is a request to be checked, never a fact to be used. In particular
 * the recipient is the SESSION address — read from an HMAC-signed httpOnly cookie — and is never
 * taken from the body. A payout address a client can name is a payout address a client can point
 * at itself while wearing someone else's standing.
 *
 * The order below is the whole design:
 *
 *   1. session            — who is this, provably
 *   2. pool               — is this a thing we offer
 *   3. already claimed?   — cheap refusal before any network call
 *   4. standing           — read live, under the session address, from VouchMe
 *   5. standing gate      — the server decides; whatever the page rendered is irrelevant
 *   5b. identity gate     — separately, and on the server's own stored conclusion
 *   6. reserve            — take the slot, synchronously, immediately before sending
 *   7. send               — and record the hash before anyone waits for a receipt
 *
 * Step 6 sits after the gates and not before, so a refused claim does not burn the caller's one
 * lifetime attempt at a pool they may qualify for tomorrow.
 *
 * 5 and 5b are two gates, not one, and they are never combined into a single boolean. Standing says
 * how much we trust this person; identity says whether we may lawfully serve them. Both must pass,
 * neither substitutes for the other, and the refusal names which one closed — because "earn Tier 2"
 * and "verify your age" are different instructions and a person told the wrong one is stuck.
 */
export async function POST(req: Request): Promise<Response> {
  // 1. Who is signed in.
  const address = readVerifiedAddress(await cookies());
  if (!address) {
    return Response.json(
      { code: "not_signed_in", error: "Sign in with World to claim." },
      { status: 401 },
    );
  }

  // 2. Which pool.
  let body: { pool?: unknown };
  try {
    body = (await req.json()) as { pool?: unknown };
  } catch {
    return Response.json({ code: "bad_request", error: "Request body must be valid JSON." }, { status: 400 });
  }
  const pool = findPool(body?.pool);
  if (!pool) {
    return Response.json({ code: "unknown_pool", error: "No such pool." }, { status: 404 });
  }

  // 3. One claim per address per pool, ever. Checked here to refuse cheaply, and taken for real at
  //    step 6 — this early read is a courtesy, not the guarantee.
  const existing = getClaim(address, pool.id);
  if (existing) {
    return Response.json(
      {
        code: "already_claimed",
        error: `${pool.name} has already been claimed by this address.`,
        txHash: existing.txHash,
      },
      { status: 409 },
    );
  }

  // 4. Standing, read live under the session address.
  const { standing, unavailable } = await readStanding(address);
  if (unavailable) {
    // Fail closed. An outage must never read as "everyone qualifies", and must not be reported as
    // a refusal either — the caller deserves to know which of the two happened.
    return Response.json(
      { code: "vouchme_unavailable", error: `VouchMe could not be reached: ${unavailable}` },
      { status: 503 },
    );
  }

  // 5. The gate. Server-side, always. The page rendering a pool as open is a rendering detail.
  if (!qualifies(pool, standing)) {
    return Response.json(
      {
        code: "not_qualified",
        error: `${pool.name} requires ${requirementLabel(pool.requirement)}.`,
        required: requirementLabel(pool.requirement),
        tier: standing?.tier ?? 0,
      },
      { status: 403 },
    );
  }

  // 5b. The identity gate. Read from Lend's OWN store, written only by `/api/identity` after World
  //     confirmed the attestation to this server. Nothing in this request can influence it: there is
  //     no attestation field in the claim body to forge, and if the client sent one it would be
  //     ignored, because this line does not look at `body`.
  //
  //     Fails closed on absence. No attestation, an expired one, or one that proved less than this
  //     pool asks for, all land here.
  const attestation = getAttestation(address);
  if (!attestationSatisfies(pool.identity, attestation)) {
    return Response.json(
      {
        code: "identity_required",
        error: attestation
          ? `${pool.name} needs an identity check covering ${identityLabel(pool.identity)}. Yours does not.`
          : `${pool.name} requires an identity check (${identityLabel(pool.identity)}).`,
        required: identityLabel(pool.identity),
        attested: Boolean(attestation),
      },
      { status: 403 },
    );
  }

  // 6. Take the slot. Synchronous, no await between the check and the write, so two requests racing
  //    on the same address and pool cannot both get through.
  const reservation = reserve(address, pool.id, pool.amountWld);
  if (!reservation.ok) {
    return Response.json(
      {
        code: "already_claimed",
        error: `${pool.name} has already been claimed by this address.`,
        txHash: reservation.existing.txHash,
      },
      { status: 409 },
    );
  }

  // 7. Send. The slot is already taken, so a slow confirmation cannot be double-spent.
  const result = await sendWld(address, pool.amountWld);
  if (!result.ok) {
    // Give the slot back ONLY when the failure provably happened before anything could reach the
    // chain — refusing to pay must not also consume the caller's one attempt. When the broadcast
    // itself threw, the slot stays taken: an RPC that times out after the node accepted the
    // transaction is indistinguishable from one that never sent it, and the safe failure is a user
    // who has to ask a human, not a treasury that pays twice.
    if (isPreBroadcast(result.failure)) release(address, pool.id);
    return Response.json({ code: result.failure.code, error: result.failure.message }, { status: result.failure.status });
  }

  recordHash(address, pool.id, result.txHash);
  return Response.json({
    pool: pool.id,
    amountWld: pool.amountWld,
    to: address,
    txHash: result.txHash,
    explorer: `https://worldscan.org/tx/${result.txHash}`,
  });
}
