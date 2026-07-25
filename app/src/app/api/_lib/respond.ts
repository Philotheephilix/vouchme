/**
 * Shared response envelope for every route in src/app/api/**.
 *
 * docs/07-app-api.md §3: "Every response carries { meta: { subgraphDeployment, computedAtBlock,
 * indexerLagBlocks, engineVersion } }." This file is the one place that rule is enforced so no
 * route handler can forget it.
 */

import { NextResponse } from "next/server";
import type { ApiEnvelope, ApiErrorBody, ApiMeta } from "@/lib/types";

/** Used only when `meta` can't be obtained at all (the live chain read itself failed) — every
 *  successful response carries the real `meta` from `loadAvalData()`, never this. */
export const FALLBACK_META: ApiMeta = {
  subgraphDeployment: "unavailable",
  computedAtBlock: 0,
  indexerLagBlocks: 0,
  engineVersion: "0.1.0",
  mode: "live",
};

export function ok<T>(data: T, meta: ApiMeta, status = 200): NextResponse<ApiEnvelope<T>> {
  const body: ApiEnvelope<T> = { data, meta };
  return NextResponse.json(body, { status });
}

export function fail(status: number, code: string, message: string, meta: ApiMeta = FALLBACK_META): NextResponse<ApiErrorBody> {
  const body: ApiErrorBody = { error: { code, message }, meta };
  return NextResponse.json(body, { status });
}

/**
 * R-9 (docs/97-review-engine-app.md): `decodeURIComponent` throws a `URIError` on malformed
 * percent-encoding (e.g. a bare "%" — verified: `decodeURIComponent("%")` throws). Every dynamic
 * GET route decodes a path segment as its first move, so an uncaught throw there escapes the route
 * handler entirely and Next.js turns it into a generic 500 instead of the standard error envelope.
 * Centralized here — once — instead of a try/catch around `decodeURIComponent` copy-pasted into
 * every one of the five route files.
 */
export type DecodeParamResult = { ok: true; value: string } | { ok: false; response: NextResponse<ApiErrorBody> };

export function decodeParam(raw: string): DecodeParamResult {
  try {
    return { ok: true, value: decodeURIComponent(raw) };
  } catch {
    return {
      ok: false,
      response: fail(400, "invalid_encoding", `"${raw}" is not validly percent-encoded.`),
    };
  }
}

/**
 * R-10 (docs/97-review-engine-app.md): a POST body of JSON `null` (or an array/primitive) parses
 * successfully via `req.json()` — only a genuinely malformed JSON *document* throws — so the
 * try/catch around the parse doesn't catch it, and the very next `body.someField` access throws a
 * bare `TypeError` that escapes the handler as an uncaught 500. Route handlers call this
 * immediately after parsing, before touching any property.
 */
export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
