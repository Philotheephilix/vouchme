import "server-only";

import { isAddress, getAddress } from "viem";
import { getEnrollmentHandle, isAddressEnrolled } from "@/lib/chain";
import { EnsConfigError, EnsMintPartialError, EnsVouchNestingUnavailableError, mintEnsVouchSubname } from "@/lib/ens";
import { isJsonObject, ok, fail, FALLBACK_META } from "@/app/api/_lib/respond";

export const dynamic = "force-dynamic";

/**
 * The vouch, as a name.
 *
 * docs/04-ens.md §7.1 maps "issuing a vouch" onto `register(label, vouchee)` **in your own
 * registry**, so a vouch from `alice` to `carol` is a real `carol.alice.vouchme.eth` whose
 * `Entry.subregistry` is carol's own registry. This route performs exactly that write on Ethereum
 * Sepolia after the vouch transaction itself has landed on World Chain Sepolia.
 *
 * It refuses to pretend. If the voucher has no registry of their own the response is a 409 with
 * the reason, and the wizard says the nested name was not minted — a screen that says "Minted"
 * while minting nothing is worse than one that says "not available".
 *
 * Idempotent: a repeated call for the same edge re-reads chain state and writes nothing.
 */
interface VouchEnsRequestBody {
  voucher?: string;
  vouchee?: string;
}

const inFlight = new Set<string>();

export async function POST(req: Request): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = await req.json();
  } catch {
    return fail(400, "invalid_json", "Request body must be valid JSON.");
  }
  if (!isJsonObject(parsed)) return fail(400, "invalid_body", "Request body must be a JSON object.");
  const body = parsed as VouchEnsRequestBody;

  if (!body.voucher || !isAddress(body.voucher)) return fail(400, "invalid_voucher", "`voucher` must be a valid address.");
  if (!body.vouchee || !isAddress(body.vouchee)) return fail(400, "invalid_vouchee", "`vouchee` must be a valid address.");
  const voucher = getAddress(body.voucher);
  const vouchee = getAddress(body.vouchee);
  if (voucher.toLowerCase() === vouchee.toLowerCase()) return fail(400, "self_vouch", "You cannot vouch for yourself.");

  const key = `${voucher.toLowerCase()}:${vouchee.toLowerCase()}`;
  if (inFlight.has(key)) return fail(409, "mint_in_progress", "This vouch name is already being minted.");

  // Both labels come from each account's own immutable on-chain enrollment handle, never from a
  // client-supplied string — the same rule /api/ens/mint follows.
  if (!(await isAddressEnrolled(voucher))) return fail(409, "voucher_not_enrolled", "The vouching wallet is not enrolled in VouchMe.");
  if (!(await isAddressEnrolled(vouchee))) return fail(409, "vouchee_not_enrolled", "The account being vouched for is not enrolled in VouchMe.");

  const voucherHandle = await getEnrollmentHandle(voucher);
  const voucheeHandle = await getEnrollmentHandle(vouchee);
  if (!voucherHandle?.endsWith(".vouchme.eth") || !voucheeHandle?.endsWith(".vouchme.eth")) {
    return fail(500, "handle_unavailable", "Could not read back the handles these addresses enrolled with.");
  }
  const voucherLabel = voucherHandle.slice(0, -".vouchme.eth".length);
  const voucheeLabel = voucheeHandle.slice(0, -".vouchme.eth".length);

  inFlight.add(key);
  try {
    const result = await mintEnsVouchSubname(voucherLabel, voucheeLabel, vouchee);
    return ok(
      {
        name: result.name,
        voucherLabel,
        voucheeLabel,
        voucherRegistry: result.voucherRegistry,
        voucheeRegistry: result.voucheeRegistry,
        voucheeRegistryDeployTxHash: result.voucheeRegistryDeployTxHash,
        voucheeRegistryAttachTxHash: result.voucheeRegistryAttachTxHash,
        registerTxHash: result.registerTxHash,
        setAddrTxHash: result.setAddrTxHash,
        setSubregistryTxHash: result.setSubregistryTxHash,
        resolvedAddress: result.resolvedAddress,
        alreadyComplete: result.alreadyComplete,
      },
      FALLBACK_META,
    );
  } catch (err) {
    if (err instanceof EnsVouchNestingUnavailableError) {
      return fail(409, "vouch_name_unavailable", err.message);
    }
    if (err instanceof EnsMintPartialError) {
      return fail(502, "vouch_name_partial", `${err.message} Retry to finish pointing it at the vouchee's address.`);
    }
    const status = err instanceof EnsConfigError ? 503 : 502;
    return fail(status, "vouch_name_failed", err instanceof Error ? err.message : "Failed to mint the vouch subname.");
  } finally {
    inFlight.delete(key);
  }
}
