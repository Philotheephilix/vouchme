/**
 * Shared fixture builders for the engine's test suite. Not itself a test file (no `*.test.ts`
 * suffix), so the node test runner will not try to execute it directly.
 */

import type { Account, EngineInput, PlatformVouch, Report, ReportState, Vouch } from "./types.js";

export function human(id: string, opts: Partial<Account> = {}): Account {
  return { id, kind: "human", ...opts };
}

export function anchorAccount(id: string, opts: Partial<Account> = {}): Account {
  return { id, kind: "human", isAnchor: true, ...opts };
}

export function platformAccount(id: string, opts: Partial<Account> = {}): Account {
  return { id, kind: "platform", ...opts };
}

export function vouch(voucher: string, vouchee: string, active = true): Vouch {
  return { voucher, vouchee, active };
}

export function platformVouch(voucher: string, platform: string, active = true): PlatformVouch {
  return { voucher, platform, active };
}

export function report(
  id: string,
  reporter: string,
  target: string,
  state: ReportState,
  opts: Partial<Report> = {},
): Report {
  return { id, reporter, target, state, ...opts };
}

export function makeInput(partial: {
  now?: number;
  accounts?: Account[];
  vouches?: Vouch[];
  platformVouches?: PlatformVouch[];
  reports?: Report[];
}): EngineInput {
  return {
    now: partial.now ?? 0,
    accounts: partial.accounts ?? [],
    vouches: partial.vouches ?? [],
    platformVouches: partial.platformVouches ?? [],
    reports: partial.reports ?? [],
  };
}

/** `n` anchor accounts, ids `anchorPrefix0`..`anchorPrefix{n-1}`. */
export function anchors(n: number, prefix = "anchor"): Account[] {
  return Array.from({ length: n }, (_, i) => anchorAccount(`${prefix}${i}`));
}
