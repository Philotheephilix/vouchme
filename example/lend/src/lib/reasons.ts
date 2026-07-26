/**
 * Report reason codes, shared by the client form and the server route.
 *
 * Deliberately NOT in `reports.ts`: that module is `server-only` because it holds the report log,
 * and the form needs these labels in the browser. One list, so a reason the form can offer is
 * always a reason the route accepts.
 *
 * The code is what goes into Lend's record; the label is what a person reads. VouchMe itself takes
 * no reason code — on chain a report carries only an evidence hash — so this vocabulary is Lend's
 * own, and stays Lend's own.
 */

export const REASON_CODES = [
  { code: "non_repayment", label: "Did not repay" },
  { code: "misrepresentation", label: "Misrepresented themselves" },
  { code: "abuse", label: "Abused the pool" },
  { code: "other", label: "Other" },
] as const;

export type ReasonCode = (typeof REASON_CODES)[number]["code"];

export function isReasonCode(value: unknown): value is ReasonCode {
  return typeof value === "string" && REASON_CODES.some((r) => r.code === value);
}

export function reasonLabel(code: string): string {
  return REASON_CODES.find((r) => r.code === code)?.label ?? code;
}
