import "server-only";

import { isAddress, getAddress } from "viem";
import { isAddressEnrolled, getEnrollmentHandle } from "@/lib/chain";
import { EnsConfigError, EnsMintPartialError, mintEnsSubname } from "@/lib/ens";
import { isJsonObject, ok, fail, FALLBACK_META } from "@/app/api/_lib/respond";

export const dynamic = "force-dynamic";

interface MintRequestBody {
  address?: string;
}

// Best-effort in-process guard against a double-click firing two mints concurrently for the same
// address before the first one's on-chain state is visible to the second request's read. The
// real, durable rate limit is on-chain: `register()` on an already-owned label reverts, and
// `mintEnsSubname` always re-derives the label from the caller's own immutable enrollment handle
// (never a client-supplied string), so no address can ever mint more than the one name it already
// committed to at `enroll()` time — this Set only closes the narrow same-instant race, not the
// long-term guarantee.
const inFlight = new Set<string>();

export async function POST(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!isJsonObject(parsed)) return fail(400, "invalid_body", "Request body must be a JSON object.");
  const body = parsed as MintRequestBody;

  if (!body.address || !isAddress(body.address)) {
    return fail(400, "invalid_address", "`address` must be a valid wallet address.");
  }
  const address = getAddress(body.address);
  const key = address.toLowerCase();

  if (inFlight.has(key)) {
    return fail(409, "mint_in_progress", "A mint for this address is already in progress.");
  }

  if (!(await isAddressEnrolled(address))) {
    return fail(409, "not_enrolled", "This wallet is not enrolled in VouchMe yet — enroll first, then a name is minted.");
  }

  const enrollmentHandle = await getEnrollmentHandle(address); // e.g. "carol.vouchme.eth"
  if (!enrollmentHandle || !enrollmentHandle.endsWith(".vouchme.eth")) {
    return fail(500, "handle_unavailable", "Could not read back the handle this address enrolled with.");
  }
  const label = enrollmentHandle.slice(0, -".vouchme.eth".length);

  inFlight.add(key);
  try {
    const result = await mintEnsSubname(label, address);
    return ok(
      {
        label,
        handle: enrollmentHandle,
        address,
        registerTxHash: result.registerTxHash,
        setAddrTxHash: result.setAddrTxHash,
        registryDeployTxHash: result.registryDeployTxHash,
        setSubregistryTxHash: result.setSubregistryTxHash,
        // docs/04-ens.md §7: "a member = a PermissionedRegistry they own". This is that registry,
        // read back from `getSubregistry(label)` after the writes — it is what makes
        // `<someone>.<label>.vouchme.eth` possible at all.
        subregistry: result.subregistry,
        resolvedAddress: result.resolvedAddress,
        alreadyComplete: result.alreadyComplete,
      },
      FALLBACK_META,
    );
  } catch (err) {
    if (err instanceof EnsMintPartialError) {
      // Enrolled, name reserved, address record not yet written — exact, retryable state, never
      // folded into a generic failure message.
      return fail(
        502,
        "ens_mint_partial",
        `${err.message} You're enrolled and "${label}.vouchme.eth" is reserved — retry to finish pointing it at your address.`,
      );
    }
    const status = err instanceof EnsConfigError ? 503 : 502;
    return fail(status, "ens_mint_failed", err instanceof Error ? err.message : "Failed to mint the ENS subname.");
  } finally {
    inFlight.delete(key);
  }
}
