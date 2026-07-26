/**
 * What has to be true before Lend claims to have an identity gate.
 *
 * Identity Check is preview-gated: World has not enabled Identity Attestations for this app id, so
 * no real attestation can be completed here, by anyone, today. That is exactly why this file exists.
 * A gate whose allow branch has never executed is not a gate that has been tested — it is a gate
 * nobody has looked at. So:
 *
 *   PART 1 runs against the dev server on :3200 with the REAL World ID verify endpoint and no
 *   Identity Check credentials configured. It proves the gate is shut: unsigned, forged, replayed
 *   and self-asserting requests all bounce, an unserved jurisdiction is refused before any document
 *   is opened, and `/api/claim` refuses the pools regardless of standing.
 *
 *   PART 2 stands up a stub World verify endpoint and a second Lend pointed at it, so the branch
 *   where World says yes is actually executed. That is the only way to demonstrate the thing that
 *   matters most: that a body claiming `identity_attested: true` is IGNORED, and that the answer
 *   comes solely from the verifier's reply. The stub is reachable only because NODE_ENV is not
 *   "production" — `src/lib/identityStore.ts` refuses to load a production build that has the
 *   override set, and ignores it even if it somehow did.
 *
 * NOTHING here fabricates a successful World attestation. The stub is a fake VERIFIER, clearly
 * labelled in every response it produces (`stubbedVerifier: true`), and it cannot be reached from a
 * production build.
 *
 * No real transaction is sent. Every run ends with an unfunded treasury on purpose.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

const BASE = process.env.LEND_URL ?? "http://localhost:3200";
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECOND_PORT = Number(process.env.LEND_IDENTITY_PORT ?? 3202);

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const post = (base, path, { cookie, body } = {}) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** The well-known hardhat account #1 — a wallet nobody owns anything with. */
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

async function signIn(base) {
  const token = await (await post(base, "/api/auth/nonce")).json();
  const message =
    `lend.example wants you to sign in with your account.\n\n` +
    `URI: ${base}\nVersion: 1\nNonce: ${token.nonce}\n` +
    `Issued At: ${new Date(token.issuedAt * 1000).toISOString()}`;
  const signature = await account.signMessage({ message });
  const res = await post(base, "/api/auth/verify", {
    body: { address: account.address, message, signature, nonce: token },
  });
  return { res, setCookie: res.headers.get("set-cookie") ?? "" };
}

/** A World ID 4.0 result envelope of the right SHAPE. The proof inside is nonsense, which is the
 *  point: nothing downstream may accept it on shape alone. */
function fakeResult(nonce, extra = {}) {
  return {
    protocol_version: "4.0",
    nonce,
    action: "lend-identity-check",
    responses: [
      {
        identifier: "passport",
        proof: ["0x01", "0x02", "0x03", "0x04", "0x05"],
        nullifier: "0x00000000000000000000000000000000000000000000000000000000000000aa",
        issuer_schema_id: 9303,
        expires_at_min: 1,
      },
    ],
    user_presence_completed: true,
    environment: "production",
    ...extra,
  };
}

// ═══ PART 1 — the live dev server, real World endpoint, no Identity Check credentials ════════════

console.log(`\n── against ${BASE} (real developer.world.org, Identity Check NOT configured) ──`);

{
  const r = await post(BASE, "/api/identity/challenge", { body: { pool: "starter" } });
  const b = await r.json();
  check("challenge without a session is refused", r.status === 401 && b.code === "not_signed_in", `${r.status} ${b.code}`);
}

{
  const r = await post(BASE, "/api/identity", { body: { idkitResult: fakeResult("0xdead") } });
  const b = await r.json();
  check("attestation POST without a session is refused", r.status === 401 && b.code === "not_signed_in", `${r.status} ${b.code}`);
}

{
  const payload = Buffer.from(
    JSON.stringify({ address: "0x86e38ef286e38ef286e38ef286e38ef286e38ef2", exp: 2000000000 }),
  ).toString("base64url");
  const cookie = `lend_session=${payload}.deadbeef`;
  const r = await post(BASE, "/api/identity", { cookie, body: { idkitResult: fakeResult("0xdead", { identity_attested: true }) } });
  const b = await r.json();
  check(
    "a forged session cookie is refused even carrying identity_attested:true",
    r.status === 401 && b.code === "not_signed_in",
    `${r.status} ${b.code}`,
  );
}

const { setCookie } = await signIn(BASE);
const cookie = setCookie.split(";")[0];
check("signed in for the rest of PART 1", Boolean(cookie), cookie.slice(0, 24) + "…");

{
  const r = await post(BASE, "/api/identity", { cookie, body: { idkitResult: fakeResult("0xnot-a-nonce-we-issued", { identity_attested: true }) } });
  const b = await r.json();
  check(
    "a proof whose nonce we never issued is refused (no challenge = no binding)",
    r.status === 400 && b.code === "unknown_challenge",
    `${r.status} ${b.code} — ${b.error}`,
  );
}

{
  const r = await post(BASE, "/api/identity", { cookie, body: { idkitResult: { ...fakeResult("x"), protocol_version: "3.0" } } });
  const b = await r.json();
  check("a legacy 3.0 result is refused — it cannot carry an attestation", r.status === 400 && b.code === "wrong_protocol", `${r.status} ${b.code}`);
}

{
  const r = await fetch(`${BASE}/api/identity`, { headers: { cookie } });
  const b = await r.json();
  check(
    "GET /api/identity reports NOT attested, and every pool shut",
    r.status === 200 && b.attested === false && Object.values(b.pools).every((v) => v === false),
    JSON.stringify(b.pools),
  );
}

// ── jurisdiction, refused server-side and refused BEFORE any document is opened ──────────────────

{
  const r = await post(BASE, "/api/identity/challenge", { cookie, body: { pool: "prime", country: "USA" } });
  const b = await r.json();
  check(
    "an unserved jurisdiction is refused server-side, with no World call at all",
    r.status === 403 && b.code === "jurisdiction_unavailable" && Array.isArray(b.served) && !b.served.includes("USA"),
    `${r.status} ${b.code} — ${b.error}`,
  );
}

{
  const r = await post(BASE, "/api/identity/challenge", { cookie, body: { pool: "prime" } });
  const b = await r.json();
  check(
    "a jurisdiction-gated pool refuses a challenge with no declared country",
    r.status === 403 && b.code === "jurisdiction_unavailable",
    `${r.status} ${b.code}`,
  );
}

{
  // A SERVED jurisdiction gets past the policy check and then hits the real wall: this app id has
  // no Identity Check credentials, so no request can be signed. Fails closed, and says why.
  const r = await post(BASE, "/api/identity/challenge", { cookie, body: { pool: "prime", country: "PRT" } });
  const b = await r.json();
  check(
    "a served jurisdiction reaches the config wall and fails CLOSED, naming what is missing",
    r.status === 503 && b.code === "identity_unavailable" && /LEND_WORLDID_/.test(b.error),
    `${r.status} ${b.code} — ${b.error}`,
  );
}

{
  const r = await post(BASE, "/api/claim", { cookie, body: { pool: "starter" } });
  const b = await r.json();
  // Standing is checked first, so this account is refused on tier before identity is consulted.
  // Both walls are standing; the point is that nothing is paid.
  check(
    "claiming is refused with no identity attestation on file",
    r.status === 403 && (b.code === "not_qualified" || b.code === "identity_required"),
    `${r.status} ${b.code} — ${b.error}`,
  );
}

// ═══ PART 2 — a stub VERIFIER, so the branch where World says yes is actually executed ═══════════

/** Swapped between checks. The route re-reads it on every request, so no restart is needed. */
let stubVerifyReply = null;
let stubCalls = 0;
let lastVerifyBody = null;

const verifier = createServer((req, res) => {
  stubCalls += 1;
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    try {
      lastVerifyBody = JSON.parse(raw);
    } catch {
      lastVerifyBody = null;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(stubVerifyReply));
  });
});
await new Promise((done) => verifier.listen(0, "127.0.0.1", done));
const verifierUrl = `http://127.0.0.1:${verifier.address().port}`;

/** A VouchMe that answers for the test wallet, so standing never masks an identity result. */
let stubStanding = { ensName: "test.eth", kind: "member", base: 20, score: 150, scoreAtRisk: 150, tier: 2, depth: 1, credentialStatus: "active", credentialExpiresAt: "2030-01-01T00:00:00.000Z" };
const vouchme = createServer((req, res) => {
  const meta = { subgraphDeployment: "stub", computedAtBlock: 1, indexerLagBlocks: 0, engineVersion: "stub", mode: "fixture" };
  if (!stubStanding || !req.url.startsWith("/api/score/")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "identity_not_found", message: "no" }, meta }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: { ...stubStanding, address: account.address }, meta }));
});
await new Promise((done) => vouchme.listen(0, "127.0.0.1", done));
const vouchmeUrl = `http://127.0.0.1:${vouchme.address().port}`;

const SECOND = `http://127.0.0.1:${SECOND_PORT}`;
// `next dev`, not `next start`, and the reason is the guard itself.
//
// `next start` forces NODE_ENV=production, and `src/lib/identityStore.ts` REFUSES TO LOAD on a
// production build that has LEND_IDENTITY_VERIFY_URL set. Setting NODE_ENV=development in this env
// does not help: Next overrides it. The first draft of this file used `next start` and every route
// in PART 2 returned a 500 — which is the guard working exactly as intended, and is the best
// evidence available that the stub cannot be reached from a production build.
//
// Its own dist dir so it cannot collide with the dev server already running on :3200.
//
// Next rewrites `next-env.d.ts` and the `include` list in `tsconfig.json` to point at whichever
// NEXT_DIST_DIR it was given. Snapshotted here and restored in the `finally` below, so running the
// tests does not leave the working tree dirty — and, more to the point, does not leave
// `next-env.d.ts` referencing a `.next-identity` directory that the next `tsc --noEmit` will not
// find.
const TOUCHED_BY_NEXT = ["next-env.d.ts", "tsconfig.json"].map((f) => resolve(APP_DIR, f));
const snapshots = TOUCHED_BY_NEXT.map((f) => [f, readFileSync(f, "utf8")]);

const child = spawn("npx", ["next", "dev", "--port", String(SECOND_PORT)], {
  cwd: APP_DIR,
  env: {
    ...process.env,
    NEXT_DIST_DIR: ".next-identity",
    VOUCHME_API_URL: vouchmeUrl,
    LEND_TREASURY_PRIVATE_KEY: "",
    // Identity Check credentials. The signing key is a throwaway used only so `signRequest` has
    // something to sign with; the resulting signature is NOT one World would accept, which is
    // precisely why PART 2 talks to a stub verifier instead of World.
    LEND_WORLDID_RP_ID: "rp_stub00000000000",
    LEND_WORLDID_ACTION: "lend-identity-check",
    LEND_WORLDID_SIGNING_KEY: "0x" + "11".repeat(32),
    LEND_IDENTITY_VERIFY_URL: verifierUrl,
  },
  stdio: "ignore",
  detached: true,
});

async function waitFor(url, ms = 40_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      await fetch(url);
      return true;
    } catch {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** Start a challenge and return the nonce the server minted for it. */
async function challenge(base, ck, body) {
  const r = await post(base, "/api/identity/challenge", { cookie: ck, body });
  const b = await r.json();
  return { status: r.status, body: b, nonce: b?.rp_context?.nonce };
}

try {
  console.log(`\n── against ${SECOND} (stub verifier at ${verifierUrl}, stub VouchMe, no treasury key) ──`);
  if (!(await waitFor(SECOND))) throw new Error(`second Lend never came up on ${SECOND}`);

  const signed = await signIn(SECOND);
  const ck = signed.setCookie.split(";")[0];

  {
    const c = await challenge(SECOND, ck, { pool: "starter" });
    check(
      "a configured server mints a signed rp_context and returns ONLY the needed attributes",
      c.status === 200 &&
        typeof c.nonce === "string" &&
        /^0x[0-9a-f]{64}$/.test(c.nonce) &&
        c.body.rp_context.signature.startsWith("0x") &&
        JSON.stringify(c.body.attributes) === JSON.stringify([{ type: "minimum_age", value: 18 }]),
      JSON.stringify(c.body.attributes),
    );
  }

  {
    const c = await challenge(SECOND, ck, { pool: "prime", country: "PRT" });
    check(
      "a jurisdiction-gated pool asks for age AND issuing country — and nothing else",
      c.status === 200 &&
        JSON.stringify(c.body.attributes) ===
          JSON.stringify([{ type: "minimum_age", value: 18 }, { type: "issuing_country", value: "PRT" }]),
      JSON.stringify(c.body.attributes),
    );
    check(
      "no request ever asks for full_name or document_number",
      !/full_name|document_number/.test(JSON.stringify(c.body.attributes)),
      JSON.stringify(c.body.attributes.map((a) => a.type)),
    );
  }

  // ── THE ONE THAT MATTERS ──────────────────────────────────────────────────────────────────────
  {
    // The verifier says the proof is good but says NOTHING about an attestation — which is exactly
    // what the real endpoint's documented response schema does today. The client, meanwhile,
    // asserts `identity_attested: true` in the body it posts.
    stubVerifyReply = {
      success: true,
      environment: "production",
      results: [{ identifier: "passport", success: true, nullifier: "0x00aa" }],
    };
    const c = await challenge(SECOND, ck, { pool: "starter" });
    const r = await post(SECOND, "/api/identity", {
      cookie: ck,
      body: { idkitResult: fakeResult(c.nonce, { identity_attested: true }) },
    });
    const b = await r.json();
    check(
      "client-asserted identity_attested:true is IGNORED when the verifier does not attest",
      r.status === 403 && b.code === "not_attested" && b.reason === "attestation_absent",
      `${r.status} ${b.code}/${b.reason} — ${b.error}`,
    );
  }

  {
    stubVerifyReply = {
      success: true,
      environment: "production",
      identity_attested: false,
      results: [{ identifier: "passport", success: true, nullifier: "0x00aa" }],
    };
    const c = await challenge(SECOND, ck, { pool: "starter" });
    const r = await post(SECOND, "/api/identity", {
      cookie: ck,
      body: { idkitResult: fakeResult(c.nonce, { identity_attested: true }) },
    });
    const b = await r.json();
    check(
      "an explicit identity_attested:false from the verifier refuses, and is told apart from absent",
      r.status === 403 && b.code === "not_attested" && b.reason === "attributes_not_matched",
      `${r.status} ${b.code}/${b.reason}`,
    );
  }

  {
    stubVerifyReply = { success: false, code: "all_verifications_failed", detail: "All proof verifications failed." };
    const c = await challenge(SECOND, ck, { pool: "starter" });
    const r = await post(SECOND, "/api/identity", { cookie: ck, body: { idkitResult: fakeResult(c.nonce, { identity_attested: true }) } });
    const b = await r.json();
    check("a proof the verifier rejects is refused", r.status === 400 && b.code === "verification_failed", `${r.status} ${b.code} — ${b.error}`);
  }

  {
    // Replay: mint one challenge, spend it, then post the same result again.
    stubVerifyReply = {
      success: true,
      environment: "production",
      identity_attested: true,
      results: [{ identifier: "passport", success: true, nullifier: "0x00bb" }],
    };
    const c = await challenge(SECOND, ck, { pool: "starter" });
    const body = { idkitResult: fakeResult(c.nonce) };
    const first = await post(SECOND, "/api/identity", { cookie: ck, body });
    const firstBody = await first.json();
    check(
      "with the verifier attesting, the ALLOW branch executes — and is labelled as stubbed",
      first.status === 200 && firstBody.attested === true && firstBody.stubbedVerifier === true && firstBody.pools.starter === true,
      `${first.status} attested=${firstBody.attested} stubbed=${firstBody.stubbedVerifier} pools=${JSON.stringify(firstBody.pools)}`,
    );
    check(
      "the attestation covers only what was proven — Starter open, jurisdiction pools still shut",
      firstBody.pools.starter === true && firstBody.pools.standard === false && firstBody.pools.prime === false,
      JSON.stringify(firstBody.pools),
    );
    const second = await post(SECOND, "/api/identity", { cookie: ck, body });
    const secondBody = await second.json();
    check(
      "the same challenge cannot be redeemed twice",
      second.status === 400 && secondBody.code === "unknown_challenge",
      `${second.status} ${secondBody.code}`,
    );
  }

  {
    // The verify request Lend sent must be built from the proof, and must not smuggle the client's
    // attestation claim into the question it asks.
    check(
      "Lend's verify request carries the proof, and never the client's identity_attested",
      lastVerifyBody?.protocol_version === "4.0" &&
        Array.isArray(lastVerifyBody?.responses) &&
        !("identity_attested" in (lastVerifyBody ?? {})),
      JSON.stringify(Object.keys(lastVerifyBody ?? {})),
    );
  }

  {
    const before = stubCalls;
    const r = await post(SECOND, "/api/identity/challenge", { cookie: ck, body: { pool: "prime", country: "USA" } });
    const b = await r.json();
    check(
      "an unserved jurisdiction never reaches the verifier at all",
      r.status === 403 && b.code === "jurisdiction_unavailable" && stubCalls === before,
      `${r.status} ${b.code}, verifier calls ${before} -> ${stubCalls}`,
    );
  }

  // ── the claim gate, with standing satisfied, so identity is the only thing left ────────────────
  {
    const r = await post(SECOND, "/api/claim", { cookie: ck, body: { pool: "prime" } });
    const b = await r.json();
    check(
      "Prime: standing PASSES (score 150) but the identity gate refuses — jurisdiction unproven",
      r.status === 403 && b.code === "identity_required",
      `${r.status} ${b.code} — ${b.error}`,
    );
  }

  {
    const r = await post(SECOND, "/api/claim", { cookie: ck, body: { pool: "prime", identity_attested: true, attested: true } });
    const b = await r.json();
    check(
      "asserting identity_attested in the CLAIM body changes nothing",
      r.status === 403 && b.code === "identity_required",
      `${r.status} ${b.code}`,
    );
  }

  {
    // Starter's identity policy IS satisfied (attested above), so the identity gate opens and the
    // claim falls through to the missing treasury key. Both gates passed; no money moved.
    const r = await post(SECOND, "/api/claim", { cookie: ck, body: { pool: "starter" } });
    const b = await r.json();
    check(
      "Starter: BOTH gates pass, then it fails closed on the missing treasury key",
      r.status === 503 && b.code === "not_configured" && b.error.includes("LEND_TREASURY_PRIVATE_KEY"),
      `${r.status} ${b.code} — ${b.error}`,
    );
  }

  {
    // Now prove the two gates are independent in the other direction: drop standing to tier 0 and
    // Starter shuts again, even though identity is still attested.
    stubStanding = { ...stubStanding, tier: 0, score: 10 };
    const r = await post(SECOND, "/api/claim", { cookie: ck, body: { pool: "starter" } });
    const b = await r.json();
    check(
      "identity attested but standing lost: Starter shuts on STANDING, not identity",
      r.status === 403 && b.code === "not_qualified",
      `${r.status} ${b.code} — ${b.error}`,
    );
    stubStanding = { ...stubStanding, tier: 2, score: 150 };
  }

  // ── the jurisdiction half, proven end to end ──────────────────────────────────────────────────
  {
    stubVerifyReply = {
      success: true,
      environment: "production",
      identity_attested: true,
      results: [{ identifier: "passport", success: true, nullifier: "0x00bb" }],
    };
    const c = await challenge(SECOND, ck, { pool: "prime", country: "PRT" });
    const r = await post(SECOND, "/api/identity", { cookie: ck, body: { idkitResult: fakeResult(c.nonce) } });
    const b = await r.json();
    check(
      "attesting a SERVED jurisdiction opens the jurisdiction-gated pools",
      r.status === 200 && b.issuingCountry === "PRT" && b.pools.prime === true && b.pools.standard === true,
      `${r.status} country=${b.issuingCountry} pools=${JSON.stringify(b.pools)}`,
    );
  }

  {
    const r = await post(SECOND, "/api/claim", { cookie: ck, body: { pool: "prime" } });
    const b = await r.json();
    check(
      "Prime: both gates now pass, and it too fails closed on the treasury key",
      r.status === 503 && b.code === "not_configured",
      `${r.status} ${b.code} — ${b.error}`,
    );
  }

  {
    // One document, one account. A second wallet presenting the same nullifier is refused.
    const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
    const token = await (await post(SECOND, "/api/auth/nonce")).json();
    const message = `lend.example wants you to sign in with your account.\n\nURI: ${SECOND}\nVersion: 1\nNonce: ${token.nonce}\nIssued At: ${new Date(token.issuedAt * 1000).toISOString()}`;
    const signature = await other.signMessage({ message });
    const vr = await post(SECOND, "/api/auth/verify", { body: { address: other.address, message, signature, nonce: token } });
    const ck2 = (vr.headers.get("set-cookie") ?? "").split(";")[0];

    const c = await challenge(SECOND, ck2, { pool: "starter" });
    const r = await post(SECOND, "/api/identity", { cookie: ck2, body: { idkitResult: fakeResult(c.nonce) } });
    const b = await r.json();
    check(
      "the same document cannot attest for a second account",
      r.status === 409 && b.code === "nullifier_reused",
      `${r.status} ${b.code} — ${b.error}`,
    );

    // And a challenge minted for one account cannot be redeemed by another.
    const c3 = await challenge(SECOND, ck, { pool: "starter" });
    const r3 = await post(SECOND, "/api/identity", { cookie: ck2, body: { idkitResult: fakeResult(c3.nonce) } });
    const b3 = await r3.json();
    check(
      "a challenge minted for one account cannot be redeemed by another",
      r3.status === 400 && b3.code === "unknown_challenge" && /different account/i.test(b3.error ?? ""),
      `${r3.status} ${b3.code} — ${b3.error}`,
    );
  }

  {
    // An unreachable verifier must deny, and must say which happened.
    verifier.close();
    await new Promise((r) => setTimeout(r, 100));
    const c = await challenge(SECOND, ck, { pool: "starter" });
    const r = await post(SECOND, "/api/identity", { cookie: ck, body: { idkitResult: fakeResult(c.nonce, { identity_attested: true }) } });
    const b = await r.json();
    check(
      "an unreachable verifier denies, and says so rather than passing",
      r.status === 502 && b.code === "worldid_unreachable",
      `${r.status} ${b.code}`,
    );
  }
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  try {
    verifier.close();
  } catch {}
  try {
    vouchme.close();
  } catch {}
  for (const [file, contents] of snapshots) {
    try {
      if (readFileSync(file, "utf8") !== contents) writeFileSync(file, contents);
    } catch {}
  }
}

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
