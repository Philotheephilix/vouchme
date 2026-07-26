"use client";

// `Tokens` and `tokenToDecimals` are only on the /commands subpath — the package root exports
// MiniKit and the provider and nothing else.
import { Tokens, tokenToDecimals } from "@worldcoin/minikit-js/commands";
import { activeMiniKit, Command, commandAvailability, ensureMiniKit, inWorldAppNow } from "@/lib/minikit";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Connect, then borrow.
 *
 * Two buttons in one, because they are two different acts and conflating them hides the important
 * one. Connecting proves you control the address whose reputation earned the discount. Borrowing is
 * the server repricing that address live and sealing what it will charge.
 *
 * The price rendered beside this button is a suggestion. `/api/borrow` recomputes it under the
 * session address, and if standing moved in between it says so instead of charging the new number.
 */

interface Paid {
  depositWld: number;
  transactionHash: string | null;
  itemName: string;
}

export function BorrowButton({
  itemId,
  depositWld,
  signedIn,
}: {
  itemId: string;
  depositWld: number;
  signedIn: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paid, setPaid] = useState<Paid | null>(null);

  // Install as early as possible. The handshake takes a moment, and doing it on mount means the
  // command is usually already available by the time somebody taps.
  useEffect(() => {
    if (inWorldAppNow()) void ensureMiniKit();
  }, []);

  const button =
    "mt-4 w-full border-2 border-stamp bg-stamp px-4 py-2.5 font-typed text-sm font-bold uppercase " +
    "tracking-[0.18em] text-card disabled:cursor-not-allowed disabled:opacity-60";

  /** Install, then check. Returns an error string, or null when the command can be issued. */
  async function readyFor(command: Command): Promise<string | null> {
    if (!inWorldAppNow()) {
      return "Open Fiar inside World App. The preview control is not a sign-in.";
    }
    const install = await ensureMiniKit();
    if (!install.ok) return `World App did not finish connecting: ${install.detail}`;
    const availability = commandAvailability(command);
    return availability.available ? null : `Cannot continue: ${availability.reason}.`;
  }

  async function connect() {
    setBusy(true);
    setError(null);
    try {
      setStep("Connecting to World App…");
      const notReady = await readyFor(Command.WalletAuth);
      if (notReady) {
        setError(notReady);
        return;
      }

      // A SERVER-issued nonce. A locally generated one proves nothing — the server would be
      // checking a challenge the client chose.
      const nonceRes = await fetch("/api/auth/nonce", { method: "POST" });
      const nonce = await nonceRes.json();
      if (!nonceRes.ok) {
        setError(nonce?.error ?? "Could not start sign-in.");
        return;
      }

      const result = await activeMiniKit().walletAuth({
        nonce: nonce.nonce,
        statement: "Prove this wallet is yours so Fiar can hold your deposit.",
      });
      const payload = result?.data;
      if (!payload?.address || !payload.signature || !payload.message) {
        setError("Sign-in was dismissed.");
        return;
      }

      const verifyRes = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          address: payload.address,
          message: payload.message,
          signature: payload.signature,
          nonce,
        }),
      });
      const verified = await verifyRes.json();
      if (!verifyRes.ok) {
        setError(verified?.error ?? "Could not verify that signature.");
        return;
      }
      // Drop any `?as=` preview: a verified session outranks it, and leaving it in the URL would
      // show one identity while the server acts as another.
      router.replace(window.location.pathname);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  async function borrow() {
    setBusy(true);
    setError(null);
    try {
      // 1. The server decides the price. Whatever is rendered next to this button is a suggestion.
      setStep("Repricing your standing…");
      const res = await fetch("/api/borrow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ item: itemId, expectedDepositMicroWld: Math.round(depositWld * 1_000_000) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "Could not authorize this borrow.");
        // The price moved or the ceiling changed under them — re-render with the real numbers
        // rather than leaving a stale figure on screen next to the error explaining it is stale.
        if (data?.code === "price_moved" || data?.code === "over_ceiling") router.refresh();
        return;
      }

      // 2. World App moves the WLD. `reference` came from the server; a client-chosen one would
      //    let a client confirm a payment it invented.
      //
      //    The install check is repeated here and not just in connect(): signing in reloads the
      //    page, which resets the module-level installed flag, so pay() would otherwise be the
      //    first command issued against an uninstalled MiniKit and fail as "unsupported".
      setStep("Waiting for World App…");
      const payNotReady = await readyFor(Command.Pay);
      if (payNotReady) {
        setError(payNotReady);
        return;
      }
      const payment = data.payment;
      const result = await activeMiniKit().pay({
        reference: payment.reference,
        to: payment.to,
        tokens: [{ symbol: Tokens.WLD, token_amount: tokenToDecimals(payment.amountWld, Tokens.WLD).toString() }],
        description: payment.description,
      });
      const payload = result?.data;
      if (!payload?.transactionId) {
        setError("The payment was cancelled.");
        return;
      }
      // Belt and braces. The server checks this too, against the Developer Portal's own record,
      // which is the check that actually counts — this one only catches a local mix-up sooner.
      if (payload.reference !== payment.reference) {
        setError("World App returned a different payment than the one Fiar opened.");
        return;
      }

      // 3. Fiar asks the Developer Portal what actually happened. Only this answer counts.
      setStep("Confirming on chain…");
      const confirmRes = await fetch("/api/pay/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reference: payment.reference, transaction_id: payload.transactionId }),
      });
      const confirmed = await confirmRes.json();
      if (!confirmRes.ok) {
        setError(confirmed?.error ?? "Could not confirm that payment.");
        return;
      }
      setPaid({
        depositWld: confirmed.depositWld,
        transactionHash: confirmed.transactionHash,
        itemName: confirmed.item?.name ?? "your item",
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Fiar could not complete the payment.");
    } finally {
      setBusy(false);
      setStep(null);
    }
  }

  if (paid) {
    return (
      <div className="mt-4 border-2 border-stamp px-4 py-3">
        <p className="font-typed text-2xs uppercase tracking-[0.2em] text-stamp">Deposit taken</p>
        <p className="mt-1 font-typed text-lg font-bold">{paid.depositWld.toFixed(4)} WLD</p>
        <p className="mt-1 text-sm leading-relaxed text-ink-soft">
          {paid.itemName} is yours to collect. Confirmed on World Chain by Fiar&apos;s server, not by this page.
        </p>
        {paid.transactionHash ? (
          <a
            className="mt-2 block break-all font-typed text-2xs text-stamp underline"
            href={`https://worldscan.org/tx/${paid.transactionHash}`}
            target="_blank"
            rel="noreferrer"
          >
            {paid.transactionHash}
          </a>
        ) : null}
        <p className="mt-2 border-t border-rule-card pt-2 text-sm leading-relaxed text-ink-soft">
          Held in Fiar&apos;s wallet, not a contract. The refund is a manual send — an escrow contract is what would
          make it enforceable.
        </p>
      </div>
    );
  }

  return (
    <>
      <button type="button" onClick={signedIn ? borrow : connect} disabled={busy} className={button}>
        {busy ? (step ?? "Working…") : signedIn ? `Borrow · ${depositWld.toFixed(4)} WLD held` : "Connect wallet to borrow"}
      </button>
      {error ? (
        <p className="mt-2 border-l-2 border-limit pl-3 text-sm leading-relaxed text-limit" role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
