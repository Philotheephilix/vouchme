import "server-only";

import { randomUUID } from "crypto";
import { getAddress, isAddress } from "viem";
import type { Address } from "./session";

/**
 * Taking the deposit.
 *
 * `MiniKit.pay()` moves WLD on World Chain from the user's World App wallet to an address this app
 * nominated. The client gets a `transactionId` back — but the client is exactly who a fraudulent
 * client would be, so that payload proves nothing on its own. The transfer is only real once THIS
 * server asks the Developer Portal what happened, under its own API key.
 *
 * The reference is what ties the two halves together. Fiar mints it server-side, remembers what it
 * was for, hands it to `pay()`, and then checks the Portal's answer carries the same reference. A
 * transaction id without a matching reference is somebody else's payment.
 *
 * HONEST LIMIT: `pay()` is a one-way transfer, so the "deposit" is a payment Fiar holds off-chain.
 * Returning it is a manual send by whoever controls the recipient wallet — there is no contract
 * enforcing the refund. An escrow contract driven by `MiniKit.sendTransaction()` is what makes the
 * refund a protocol rather than a promise. The UI says this rather than implying custody it does
 * not have.
 */

export class PaymentConfigError extends Error {}

const PORTAL_BASE = "https://developer.worldcoin.org/api/v2/minikit";

export function getAppId(): string {
  const appId = process.env.NEXT_PUBLIC_APP_ID;
  if (!appId?.startsWith("app_")) {
    throw new PaymentConfigError("NEXT_PUBLIC_APP_ID is not set to a World Developer Portal app id.");
  }
  return appId;
}

export function getRecipient(): Address {
  const to = process.env.FIAR_PAYMENT_RECIPIENT;
  if (!to || !isAddress(to)) {
    throw new PaymentConfigError(
      "FIAR_PAYMENT_RECIPIENT is not set to a valid address. It must also be whitelisted under " +
        "Payments in the Developer Portal app, or World App refuses the transfer.",
    );
  }
  return getAddress(to);
}

function getApiKey(): string {
  const key = process.env.DEV_PORTAL_API_KEY;
  if (!key) {
    throw new PaymentConfigError(
      "DEV_PORTAL_API_KEY is not set. Fiar will not mark a deposit paid on a client's say-so, so " +
        "payments are disabled without it.",
    );
  }
  return key;
}

// ─── pending payments ────────────────────────────────────────────────────────────────────────────

export interface PendingPayment {
  reference: string;
  subject: Address;
  itemId: string;
  /** The karma-derived deposit, in micro-WLD (1e-6 WLD) so it stays an integer.
   *
   *  This IS the amount transferred. There is no separate settlement figure: the catalogue is
   *  priced in WLD, so what karma computes is what the wallet pays. An earlier version charged a
   *  fixed token amount alongside a dollar quote, and carrying two numbers that could diverge was
   *  the most dishonest thing in the app. */
  depositMicroWld: number;
  createdAt: number;
}

/**
 * Pinned to `globalThis`, not a module-level `const`.
 *
 * A plain module-level Map does not work: `/api/borrow` opens the payment and `/api/pay/confirm`
 * looks it up, and Next gives each route handler its own module instance — so the writing Map and
 * the reading Map are different objects and every reference comes back unknown. That failure is
 * silent and looks exactly like an expired reference, which is why it is worth a comment rather
 * than a shrug.
 *
 * Still one process, so this resets on restart, which only strands in-flight references. A
 * multi-instance deployment needs shared storage (Redis, Postgres) — a user who lands on instance
 * B after paying through instance A cannot be confirmed otherwise.
 */
const globalStore = globalThis as typeof globalThis & { __fiarPendingPayments?: Map<string, PendingPayment> };
const pending: Map<string, PendingPayment> = (globalStore.__fiarPendingPayments ??= new Map());
const PENDING_TTL_MS = 15 * 60 * 1000;

export function openPayment(subject: Address, itemId: string, depositMicroWld: number): PendingPayment {
  const now = Date.now();
  for (const [ref, p] of pending) if (now - p.createdAt > PENDING_TTL_MS) pending.delete(ref);
  // World App requires the reference to be alphanumeric, so the UUID's dashes come out.
  const record: PendingPayment = {
    reference: randomUUID().replace(/-/g, ""),
    subject,
    itemId,
    depositMicroWld,
    createdAt: now,
  };
  pending.set(record.reference, record);
  return record;
}

/** Looks up without consuming. A payment still in the mempool has to be checkable again, so the
 *  reference is only retired once it has actually confirmed — see `closePayment`. */
export function peekPayment(reference: string): PendingPayment | null {
  const record = pending.get(reference);
  if (!record) return null;
  if (Date.now() - record.createdAt > PENDING_TTL_MS) {
    pending.delete(reference);
    return null;
  }
  return record;
}

/** Retires a reference so a confirmed payment cannot be redeemed twice. */
export function closePayment(reference: string): void {
  pending.delete(reference);
}

// ─── Developer Portal confirmation ───────────────────────────────────────────────────────────────

export interface PortalTransaction {
  reference?: string;
  transactionStatus?: string;
  transactionHash?: string;
  transactionId?: string;
  tokenAmount?: string;
  token?: string;
  recipientAddress?: string;
  fromWalletAddress?: string;
  chain?: string;
}

export type ConfirmResult =
  | { ok: true; transaction: PortalTransaction }
  | { ok: false; reason: string; transaction?: PortalTransaction };

/**
 * Asks the Developer Portal what actually happened on chain.
 *
 * `failed` is terminal. `pending`/`submitted` is not an error — World Chain blocks are fast but not
 * instant, and reporting "failed" for a transaction still in the mempool would tell a user their
 * money vanished when it did not.
 */
export async function confirmPayment(transactionId: string, expected: PendingPayment): Promise<ConfirmResult> {
  const url = `${PORTAL_BASE}/transaction/${encodeURIComponent(transactionId)}?app_id=${encodeURIComponent(getAppId())}&type=payment`;

  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${getApiKey()}` },
      cache: "no-store",
    });
  } catch {
    return { ok: false, reason: "Could not reach the World Developer Portal to confirm the payment." };
  }
  if (!response.ok) {
    return { ok: false, reason: `The Developer Portal returned ${response.status} for that transaction.` };
  }

  const tx = (await response.json().catch(() => null)) as PortalTransaction | null;
  if (!tx) return { ok: false, reason: "The Developer Portal returned an unreadable response." };

  // The whole point of the reference: without this check, any transaction id from any payment in
  // this app would confirm any deposit.
  if (tx.reference !== expected.reference) {
    return { ok: false, reason: "That transaction belongs to a different payment.", transaction: tx };
  }
  if (tx.transactionStatus === "failed") {
    return { ok: false, reason: "The payment failed on chain.", transaction: tx };
  }
  if (tx.transactionStatus !== "mined" && tx.transactionStatus !== "confirmed") {
    return { ok: false, reason: `The payment is still ${tx.transactionStatus ?? "in flight"}. Check again shortly.`, transaction: tx };
  }

  // The reference proves WHICH payment; this proves it was for the right AMOUNT. Without it a
  // wallet could settle a fraction of the asking price against a valid reference and be marked
  // paid, because every other check would still pass.
  if (tx.tokenAmount !== undefined) {
    const paidAtomic = BigInt(tx.tokenAmount);
    // micro-WLD -> wei, exactly: 1e-6 WLD is 1e12 wei at 18 decimals. Integer maths throughout, so
    // no float can make the required amount come out smaller than what was quoted.
    const requiredAtomic = BigInt(expected.depositMicroWld) * 1_000_000_000_000n;
    if (paidAtomic < requiredAtomic) {
      return {
        ok: false,
        reason: "The amount paid is less than the deposit that was quoted.",
        transaction: tx,
      };
    }
  }
  return { ok: true, transaction: tx };
}
