// @aval/gateway — src/sign.ts
//
// EIP-191 signing of CCIP-Read gateway responses (docs/04-ens.md §3).
//
// We use the "data with intended validator" scheme (EIP-191 version 0x00)
// popularized by ENS's own off-chain resolver reference implementation
// (nick.eth's OffchainResolver / SignatureVerifier.sol, and the pattern
// `resolverworks/durin` and `gskril/ens-offchain-registrar` both follow):
//
//   digest = keccak256( 0x1900 ++ target ++ expires ++ keccak256(request) ++ keccak256(result) )
//   sig    = secp256k1_sign(digest, gatewaySignerKey)
//
// `target` is the resolver contract address (the CCIP-Read `sender`), so a
// signature cannot be replayed against a different resolver deployment.
// `expires` bounds replay in time. The L1 resolver's `resolveWithProof`
// recomputes the same digest and `ecrecover`s it against a configured
// signer address — a malicious gateway can refuse to answer, but it
// cannot forge an answer (docs/04-ens.md §3, "Why a gateway rather than
// on-chain storage").
//
// The signing key is READ FROM THE ENVIRONMENT ONLY. It must never be
// hardcoded (see .env.example — GATEWAY_SIGNER_PRIVATE_KEY).

import { encodeAbiParameters, encodePacked, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAddress, sign } from "viem/accounts";

export interface SignedGatewayResponse {
  /** The raw ABI-encoded answer (what the resolver's `resolve()` ultimately returns). */
  result: Hex;
  /** Unix seconds after which this response must not be trusted. */
  expires: bigint;
  /** 65-byte (r,s,v) signature over the digest described above. */
  sig: Hex;
}

export interface SignGatewayResponseParams {
  privateKey: Hex;
  /** The resolver contract that will call resolveWithProof — the CCIP-Read `sender`. */
  target: Address;
  /** The original, undecoded calldata sent to the gateway. */
  request: Hex;
  /** The ABI-encoded answer to be returned. */
  result: Hex;
  ttlSeconds?: number;
}

export function gatewaySignerAddress(privateKey: Hex): Address {
  return privateKeyToAddress(privateKey);
}

function digest(target: Address, expires: bigint, request: Hex, result: Hex): Hex {
  return keccak256(
    encodePacked(
      ["bytes2", "address", "uint64", "bytes32", "bytes32"],
      ["0x1900", target, expires, keccak256(request), keccak256(result)],
    ),
  );
}

export async function signGatewayResponse(
  params: SignGatewayResponseParams,
): Promise<SignedGatewayResponse> {
  const ttlSeconds = params.ttlSeconds ?? 30; // docs/04-ens.md §3.2 — gateway response TTL
  const expires = BigInt(Math.floor(Date.now() / 1000) + ttlSeconds);
  const hash = digest(params.target, expires, params.request, params.result);
  const sig = await sign({ hash, privateKey: params.privateKey, to: "hex" });
  return { result: params.result, expires, sig };
}

/**
 * Encodes (result, expires, sig) into the single `bytes` blob the on-chain
 * `resolveWithProof(bytes response, bytes extraData)` callback expects to
 * `abi.decode` — the same wire shape as ENS's reference OffchainResolver.
 */
export function encodeGatewayResponseBody(response: SignedGatewayResponse): Hex {
  return encodeAbiParameters(
    [{ type: "bytes" }, { type: "uint64" }, { type: "bytes" }],
    [response.result, response.expires, response.sig],
  );
}

/**
 * Reads the signer key from the environment. Throws rather than silently
 * running unsigned — an unsigned gateway response cannot be verified
 * on-chain and must never be served.
 */
export function loadSignerKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Hex {
  const key = env.GATEWAY_SIGNER_PRIVATE_KEY;
  if (!key || !key.startsWith("0x")) {
    throw new Error(
      "GATEWAY_SIGNER_PRIVATE_KEY is not set. Refusing to sign gateway responses with no key " +
        "(see gateway/.env.example). This key is never hardcoded in source.",
    );
  }
  return key as Hex;
}
