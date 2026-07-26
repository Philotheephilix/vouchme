"use client";

import { useState } from "react";
import { REASON_CODES } from "@/lib/reasons";

/**
 * Report someone.
 *
 * Sends the name as typed. Resolution happens on the server, because the address a report is filed
 * against must not be one the client chose — `mallory` resolving to an address of the caller's
 * picking is the whole attack.
 *
 * Every refusal is shown as it arrived. VouchMe's messages cite the contract line or the doc
 * section that refuses ("a platform needs tier >= P1 (40.00) to report"), and those sentences are
 * more useful than any paraphrase this component could write.
 */

interface Filed {
  target: string;
  ensName: string | null;
  weightPoints: number;
  bondWei: string;
  fileTxHash: string;
  scoreRequestTxHash: string | null;
}

const vouchme = (wei: string) => (Number(BigInt(wei) / BigInt("1000000000000000")) / 1000).toLocaleString();

export function ReportForm({ signedIn }: { signedIn: boolean }) {
  const [subject, setSubject] = useState("");
  const [reasonCode, setReasonCode] = useState<string>(REASON_CODES[0].code);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filed, setFiled] = useState<Filed | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subject, reasonCode, note }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? "The report could not be filed.");
        return;
      }
      setFiled(data as Filed);
      setSubject("");
      setNote("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The report could not be filed.");
    } finally {
      setBusy(false);
    }
  }

  if (filed) {
    return (
      <div>
        <p className="bond-note">
          Filed against <strong>{filed.ensName ?? filed.target}</strong> at weight{" "}
          {(filed.weightPoints / 100).toFixed(2)}, bonded for {vouchme(filed.bondWei)} VOUCHME. Their vouchers have 72
          hours to rebut. Until then their score is unchanged and only <em>scoreAtRisk</em> moves.
        </p>
        <a className="sent" href={`https://worldscan.org/tx/${filed.fileTxHash}`} target="_blank" rel="noreferrer">
          ReportFiled · {filed.fileTxHash.slice(0, 10)}…{filed.fileTxHash.slice(-8)}
        </a>
        {filed.scoreRequestTxHash ? (
          <p className="report-meta">
            ScoreRequest recorded first:{" "}
            <a href={`https://worldscan.org/tx/${filed.scoreRequestTxHash}`} target="_blank" rel="noreferrer">
              {filed.scoreRequestTxHash.slice(0, 10)}…
            </a>
          </p>
        ) : null}
        <button type="button" className="btn btn-quiet" style={{ marginTop: "0.9rem" }} onClick={() => setFiled(null)}>
          Report someone else
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit}>
      <label className="field">
        <span className="label">Who</span>
        <input
          className="input"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder="mallory.vouchme.eth"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
        />
      </label>

      <label className="field">
        <span className="label">Reason</span>
        <select className="select" value={reasonCode} onChange={(e) => setReasonCode(e.target.value)}>
          {REASON_CODES.map((r) => (
            <option key={r.code} value={r.code}>
              {r.label}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="label">What happened</span>
        <textarea
          className="textarea"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Only the hash of this goes on chain. The words stay on Lend."
          maxLength={500}
        />
      </label>

      <p className="bond-note">
        Lend files this under its own name and bonds its own VOUCHME behind it. If the subject&apos;s vouchers rebut and
        a jury finds the accusation malicious, that bond is slashed and Lend can never report again.
      </p>

      {error ? <p className="error">{error}</p> : null}

      <button type="submit" className="btn btn-wide btn-danger" disabled={busy || !signedIn || subject.trim() === ""}>
        {busy ? "Filing…" : signedIn ? "File report" : "Sign in to report"}
      </button>
    </form>
  );
}
