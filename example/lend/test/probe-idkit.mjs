/**
 * Evidence, not a test.
 *
 * Every claim in IDENTITY-CHECK-TESTING.md §D about what `@worldcoin/idkit-core@4.2.2` actually puts
 * on the wire is reproducible by running this file. It builds real Identity Check requests against
 * the real bridge and prints the decrypted request payload, so nothing in the write-up has to be
 * taken on trust.
 *
 * It sends no proof and completes no verification: a request is created, its payload is dumped, and
 * the process exits. `npm run test:probe`.
 */

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { IDKit, identityCheck, orbLegacy, proofOfHuman } from "@worldcoin/idkit-core";
import { signRequest } from "@worldcoin/idkit-core/signing";
import { hashSignal } from "@worldcoin/idkit-core/hashing";

// ── FINDING D2, demonstrated by the fact that this shim is necessary ─────────────────────────────
// `initIDKit()` resolves its WASM as `new URL("idkit_wasm_bg.wasm", import.meta.url)` and hands that
// to `fetch()` (node_modules/@worldcoin/idkit-core/dist/index.js:2208-2212). Under Node that is a
// file:// URL, which Node's fetch does not implement, so every builder call dies with
// "Failed to initialize IDKit WASM: TypeError: fetch failed". `initIDKit` takes no argument and no
// `initSync`/`initFromBytes` is exported, so there is no supported escape hatch. Delete this shim to
// reproduce the failure.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(typeof input === "string" ? input : (input?.href ?? input?.url ?? ""));
  if (url.startsWith("file://")) {
    return new Response(await readFile(fileURLToPath(url)), { headers: { "content-type": "application/wasm" } });
  }
  return realFetch(input, init);
};

const APP_ID = process.env.PROBE_APP_ID ?? "app_6876091cf45989753582a3595b9b8167";
const RP_ID = process.env.PROBE_RP_ID ?? "rp_b13792fb4ff6f738";
const ACTION = process.env.PROBE_ACTION ?? "lend-identity-check";
/** A throwaway. The bridge does not check the RP signature at request-creation time — see D5. */
const KEY = "0x" + "11".repeat(32);

function rpContext() {
  const s = signRequest({ signingKeyHex: KEY, action: ACTION, ttl: 300 });
  return { rp_id: RP_ID, nonce: s.nonce, created_at: s.createdAt, expires_at: s.expiresAt, signature: s.sig };
}

async function build(preset, allowLegacy = false) {
  return IDKit.request({
    app_id: APP_ID,
    action: ACTION,
    rp_context: rpContext(),
    allow_legacy_proofs: allowLegacy,
  }).preset(preset);
}

console.log("── D1/D6: what an Identity Check request actually puts on the wire ──\n");
{
  const req = await build(
    identityCheck({
      attributes: [
        { type: "minimum_age", value: 18 },
        { type: "issuing_country", value: "PRT" },
      ],
      legacy_signal: "lend-identity:0xabc:deadbeef",
    }),
  );
  const p = req.getDebugReport().request_payload;
  console.log("identity_attributes:", JSON.stringify(p.identity_attributes));
  console.log("credential constraints:", JSON.stringify(p.proof_request.constraints));
  console.log("proof_request signature covers:", Object.keys(p.proof_request).sort().join(", "));
  console.log(
    "identity_attributes is a SIBLING of proof_request, i.e. OUTSIDE the RP signature:",
    Object.prototype.hasOwnProperty.call(p, "identity_attributes") &&
      !Object.prototype.hasOwnProperty.call(p.proof_request, "identity_attributes"),
  );
}

console.log("\n── D3: `legacy_signal` is not legacy-only — it reaches the v4 credential requests ──\n");
{
  const signal = "lend-identity:0xabc:deadbeef";
  const req = await build(identityCheck({ attributes: [{ type: "minimum_age", value: 18 }], legacy_signal: signal }));
  const p = req.getDebugReport().request_payload;
  console.log("legacy (top-level) signal:", p.signal);
  console.log("hashSignal(legacy_signal) :", hashSignal(signal));
  console.log("v4 proof_requests[].signal:", JSON.stringify(p.proof_requests ?? p.proof_request.proof_requests.map((r) => r.signal)));
}

console.log("\n── D4: `allow_legacy_proofs: false` is not honoured for v4 presets ──\n");
for (const [name, mk] of [
  ["identityCheck", () => identityCheck({ attributes: [{ type: "minimum_age", value: 18 }] })],
  ["proofOfHuman", () => proofOfHuman()],
  ["orbLegacy", () => orbLegacy()],
]) {
  for (const allow of [false, true]) {
    const p = (await build(mk(), allow)).getDebugReport().request_payload;
    console.log(`${name.padEnd(14)} config=${String(allow).padEnd(5)} -> wire allow_legacy_proofs=${p.allow_legacy_proofs}`);
  }
}

console.log("\n── D7: an EMPTY attribute list is accepted at every layer ──\n");
{
  const p = (await build(identityCheck({ attributes: [] }))).getDebugReport().request_payload;
  console.log("attributes: []  ->  wire identity_attributes:", JSON.stringify(p.identity_attributes), "(no error, no warning)");
}

process.exit(0);
