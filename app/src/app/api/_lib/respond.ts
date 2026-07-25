/**
 * Shared response envelope for every route in src/app/api/**.
 *
 * docs/07-app-api.md §3: "Every response carries { meta: { subgraphDeployment, computedAtBlock,
 * indexerLagBlocks, engineVersion } }." This file is the one place that rule is enforced so no
 * route handler can forget it.
 */

import { NextResponse } from "next/server";
import { MOCK_META } from "@/lib/mock";
import type { ApiEnvelope, ApiErrorBody } from "@/lib/types";

export function ok<T>(data: T, status = 200): NextResponse<ApiEnvelope<T>> {
  const body: ApiEnvelope<T> = { data, meta: MOCK_META };
  return NextResponse.json(body, { status });
}

export function fail(status: number, code: string, message: string): NextResponse<ApiErrorBody> {
  const body: ApiErrorBody = { error: { code, message }, meta: MOCK_META };
  return NextResponse.json(body, { status });
}
