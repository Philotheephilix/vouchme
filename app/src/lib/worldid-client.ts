/**
 * app/src/lib/worldid-client.ts
 *
 * Client-side World ID helpers shared by the enroll and vouch wizards.
 */

export interface RpContext {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
}

/** Fetches a freshly-signed RP context from our backend (`signRequest`, server-only key —
 *  src/lib/attestation.ts). `@worldcoin/idkit`'s `IDKitRequestConfig.rp_context` is a required
 *  field on every request; a client can't self-sign it without exposing the signing key. */
export async function fetchRpContext(): Promise<RpContext> {
  const res = await fetch("/api/enroll/rp-context");
  const body = await res.json();
  if (!res.ok || body?.error) {
    throw new Error(body?.error?.message ?? "Failed to prepare a World ID verification request.");
  }
  return body.data as RpContext;
}

/** Binds a vouch presence proof to one specific edge (docs/03-worldid.md §5.1): "a proof for edge
 *  A→B cannot be replayed as A→C." Both addresses lowercased for a stable, case-insensitive
 *  signal regardless of how the caller checksums them. */
export function encodeVouchSignal(voucher: string, vouchee: string): string {
  return `aval-vouch:${voucher.toLowerCase()}:${vouchee.toLowerCase()}`;
}
