/**
 * Typed fetch helpers for the route handlers in src/app/api/**.
 *
 * These call our OWN Next.js API routes (same shapes as docs/07-app-api.md §3), which are
 * currently stubbed against src/lib/mock.ts. Swapping the mock for a live engine only requires
 * changing the route handlers — every caller of this module keeps working unchanged.
 */

import type {
  ApiEnvelope,
  ApiErrorBody,
  CandidateVoucher,
  GatePolicy,
  GateResult,
  HealthResult,
  IdentityResult,
  PathResult,
  ScoreResult,
  SimulateVouchResult,
} from "./types";

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = (await res.json()) as ApiEnvelope<T> | ApiErrorBody;
  if (!res.ok || "error" in body) {
    const errBody = body as ApiErrorBody;
    throw new ApiError(res.status, errBody.error?.code ?? "unknown_error", errBody.error?.message ?? "Request failed");
  }
  return (body as ApiEnvelope<T>).data;
}

export function getIdentity(idOrAddress: string): Promise<IdentityResult> {
  return request<IdentityResult>(`/api/identity/${encodeURIComponent(idOrAddress)}`);
}

export function getScore(address: string): Promise<ScoreResult> {
  return request<ScoreResult>(`/api/score/${encodeURIComponent(address)}`);
}

export function getExplain(address: string): Promise<{ prose: string }> {
  return request<{ prose: string }>(`/api/explain/${encodeURIComponent(address)}`);
}

export function postGate(address: string, policy: GatePolicy): Promise<GateResult> {
  return request<GateResult>(`/api/gate`, { method: "POST", body: JSON.stringify({ address, policy }) });
}

export function getPath(from: string, to: string): Promise<PathResult> {
  return request<PathResult>(`/api/path/${encodeURIComponent(from)}/${encodeURIComponent(to)}`);
}

export function getCandidates(address: string): Promise<CandidateVoucher[]> {
  return request<CandidateVoucher[]>(`/api/candidates/${encodeURIComponent(address)}`);
}

export function postSimulateVouch(voucher: string, target: string): Promise<SimulateVouchResult> {
  return request<SimulateVouchResult>(`/api/simulate/vouch`, {
    method: "POST",
    body: JSON.stringify({ voucher, target }),
  });
}

export function getHealth(): Promise<HealthResult> {
  return request<HealthResult>(`/api/health`);
}
