import { cookies } from "next/headers";
import { findItem } from "@/lib/catalog";
import { quote } from "@/lib/policy";
import { getRecipient, openPayment, PaymentConfigError } from "@/lib/payment";
import { AuthConfigError, readVerifiedAddress, signBlob } from "@/lib/session";
import { readProximity, readStanding } from "@/lib/vouchme";

export const dynamic = "force-dynamic";

/** How long a sealed quote stays chargeable. Short on purpose: a vouch can be revoked in one tap
 *  and takes effect on the next read, so an hour-old price may be a price nobody earned any more. */
const QUOTE_TTL_SECONDS = 5 * 60;

interface BorrowBody {
  item?: string;
  /** What the borrower saw on screen, in micro-WLD. Not trusted — compared. */
  expectedDepositMicroWld?: number;
}

/**
 * Authorizes a borrow: the server decides who you are, re-reads your standing, and reprices.
 *
 * Nothing here trusts the page the request came from. The address comes from the HMAC-bound session
 * cookie, not from the body; the price is recomputed from a live VouchMe read, not read off the
 * request. The rendered page is a suggestion — this is the decision.
 *
 * It does not move money. It ends by sealing the price into a token the payment step will present,
 * so the amount charged is the amount this server computed rather than one a client chose.
 */
export async function POST(req: Request): Promise<Response> {
  let address;
  try {
    address = readVerifiedAddress(await cookies());
  } catch (err) {
    if (err instanceof AuthConfigError) return Response.json({ error: err.message }, { status: 503 });
    throw err;
  }
  if (!address) {
    return Response.json(
      { error: "Sign in with your World App wallet before borrowing.", code: "not_signed_in" },
      { status: 401 },
    );
  }

  let body: BorrowBody;
  try {
    body = (await req.json()) as BorrowBody;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const item = body?.item ? findItem(body.item) : undefined;
  if (!item) return Response.json({ error: "Unknown item." }, { status: 404 });

  // Fresh reads, under the SESSION address. A `?as=` preview name in the page that produced this
  // request has no effect here, which is the whole point of the split.
  const [{ standing, unavailable }, hops] = await Promise.all([
    readStanding(address),
    readProximity(address, [item]),
  ]);
  if (unavailable) {
    return Response.json(
      { error: `${unavailable} Fiar will not set a deposit it cannot justify.`, code: "vouchme_unavailable" },
      { status: 503 },
    );
  }

  const closeness = hops.get(item.id) ?? null;
  const q = quote({ item, standing, hopsToOwner: closeness?.hops ?? null });

  if (!q.withinCeiling) {
    return Response.json(
      {
        error: `This is worth ${item.valueWld.toFixed(4)} WLD and your limit is ${q.ceilingWld.toFixed(4)} WLD.`,
        code: "over_ceiling",
        quote: q,
      },
      { status: 403 },
    );
  }

  // Standing is a pure function of current graph state, so the price genuinely can differ from the
  // one rendered a minute ago — a voucher revoking, an edge expiring, a report landing. Say so
  // rather than silently charging the new number.
  const serverMicroWld = Math.round(q.depositWld * 1_000_000);
  if (typeof body.expectedDepositMicroWld === "number" && body.expectedDepositMicroWld !== serverMicroWld) {
    return Response.json(
      {
        error: "Your standing changed since this page loaded. Check the new deposit before continuing.",
        code: "price_moved",
        shownDepositWld: body.expectedDepositMicroWld / 1_000_000,
        quote: q,
      },
      { status: 409 },
    );
  }

  const authorization = signBlob(
    "borrow",
    {
      subject: address,
      item: item.id,
      depositMicroWld: serverMicroWld,
      rateMicroWldPerDay: Math.round(q.ratePerDayWld * 1_000_000),
      owner: item.owner,
      computedAtBlock: standing?.meta.computedAtBlock ?? null,
    },
    QUOTE_TTL_SECONDS,
  );

  // Open the payment against the price this server just computed, not one the client will send.
  let payment;
  try {
    const record = openPayment(address, item.id, serverMicroWld);
    payment = {
      reference: record.reference,
      to: getRecipient(),
      /** The karma-derived deposit itself. One number, and it is the one that moves. */
      amountWld: q.depositWld,
      description: `Fiar deposit — ${item.name}`,
    };
  } catch (err) {
    if (err instanceof PaymentConfigError) {
      return Response.json({ error: err.message, code: "payment_unconfigured", quote: q }, { status: 503 });
    }
    throw err;
  }

  return Response.json({
    subject: address,
    payment,
    standing: standing
      ? { ensName: standing.ensName, score: standing.score, tier: standing.tier, kind: standing.kind }
      : null,
    item: { id: item.id, name: item.name, owner: item.owner, valueWld: item.valueWld },
    quote: q,
    closeness,
    /** Present this to the payment step. It is what fixes the amount. */
    authorization,
    expiresInSeconds: QUOTE_TTL_SECONDS,
    vouchme: standing?.meta ?? null,
  });
}
