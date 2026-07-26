import { cookies } from "next/headers";
import { findItem } from "@/lib/catalog";
import { closePayment, confirmPayment, PaymentConfigError, peekPayment } from "@/lib/payment";
import { AuthConfigError, readVerifiedAddress, signBlob } from "@/lib/session";

export const dynamic = "force-dynamic";

interface ConfirmBody {
  reference?: string;
  transaction_id?: string;
}

/**
 * Turns a `MiniKit.pay()` payload into a confirmed deposit.
 *
 * The client's payload is a claim, not evidence. This route re-derives everything that matters from
 * two sources the client does not control: the session cookie (who), and the Developer Portal's own
 * record of the transaction (what actually happened on chain). The reference minted at borrow time
 * is what proves the two describe the same payment.
 *
 * Three things are checked, and skipping any one of them makes the whole flow decorative:
 *   1. the session address matches the address the payment was opened for
 *   2. the Portal's record carries our reference
 *   3. the transaction actually mined
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
    return Response.json({ error: "Sign in before confirming a payment.", code: "not_signed_in" }, { status: 401 });
  }

  let body: ConfirmBody;
  try {
    body = (await req.json()) as ConfirmBody;
  } catch {
    return Response.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const reference = typeof body?.reference === "string" ? body.reference : "";
  const transactionId = typeof body?.transaction_id === "string" ? body.transaction_id : "";
  if (!reference || !transactionId) {
    return Response.json({ error: "`reference` and `transaction_id` are both required." }, { status: 400 });
  }

  const record = peekPayment(reference);
  if (!record) {
    return Response.json(
      { error: "That payment reference is unknown or has expired.", code: "unknown_reference" },
      { status: 404 },
    );
  }
  // The reference was opened for a specific wallet. A different signed-in wallet presenting it is
  // trying to claim somebody else's payment.
  if (record.subject.toLowerCase() !== address.toLowerCase()) {
    return Response.json({ error: "That payment was opened for a different wallet.", code: "wrong_subject" }, { status: 403 });
  }

  let result;
  try {
    result = await confirmPayment(transactionId, record);
  } catch (err) {
    if (err instanceof PaymentConfigError) {
      return Response.json({ error: err.message, code: "payment_unconfigured" }, { status: 503 });
    }
    throw err;
  }
  if (!result.ok) {
    // Deliberately NOT retired: a transaction still in the mempool has to be checkable again.
    return Response.json({ error: result.reason, code: "not_confirmed", status: result.transaction?.transactionStatus ?? null }, { status: 409 });
  }

  closePayment(reference);
  const item = findItem(record.itemId);

  return Response.json({
    paid: true,
    subject: address,
    item: item ? { id: item.id, name: item.name, owner: item.owner } : { id: record.itemId },
    depositWld: record.depositMicroWld / 1_000_000,
    token: "WLD",
    transactionHash: result.transaction.transactionHash ?? null,
    // The receipt is signed so the collection step can verify this deposit was taken by this server
    // for this person, without trusting whatever the borrower shows the owner on their screen.
    receipt: signBlob(
      "deposit-receipt",
      {
        subject: address,
        item: record.itemId,
        depositMicroWld: record.depositMicroWld,
        transactionHash: result.transaction.transactionHash ?? null,
      },
      60 * 60 * 24 * 30,
    ),
    // Stated in the API, not only in the UI, because an integrator reading this response is exactly
    // who needs to know the money is not in escrow.
    custody:
      "Held by Fiar's payment wallet, not by a contract. Returning it is a manual send. Use " +
      "MiniKit.sendTransaction against an escrow contract to make the refund enforceable.",
  });
}
