/**
 * What has to be true before this app is allowed to hold a treasury key.
 *
 * Two halves:
 *
 *   PART 1 runs against the dev server on :3200, pointed at the real VouchMe dev server. It proves
 *   the page serves, the challenge is issued, and that claiming is closed to anyone without a
 *   provable session — including a hand-forged cookie and a body that names someone else's address.
 *
 *   PART 2 exists because the VouchMe dev server in fixture mode resolves ENS names only: ask it
 *   about ANY address and it answers 404, so no signed-in wallet can ever qualify against it and
 *   the entire allow-branch of the gate would go untested. So this half stands up a stub VouchMe
 *   that answers for the test wallet's own address, runs a second Lend against it, and checks the
 *   gate from the other side — that an Orb anchor clears Prime, that a tier-2 member does NOT, and
 *   that an allowed claim with no treasury key configured fails closed naming the variable rather
 *   than reporting a payout that never happened.
 *
 * No real transaction is sent. Every run ends with an unfunded treasury on purpose.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { privateKeyToAccount } from "viem/accounts";

const BASE = process.env.LEND_URL ?? "http://localhost:3200";
const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECOND_PORT = Number(process.env.LEND_STUB_PORT ?? 3201);

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

const claim = (base, cookie, body) => post(base, "/api/claim", { cookie, body });

/** A wallet nobody owns anything with — the well-known hardhat account #1. */
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");

/** Sign in for real: server nonce -> signed SIWE message -> verified session cookie. */
async function signIn(base) {
  const nonceRes = await post(base, "/api/auth/nonce");
  const token = await nonceRes.json();
  const message =
    `lend.example wants you to sign in with your account.\n\n` +
    `URI: ${base}\nVersion: 1\nNonce: ${token.nonce}\n` +
    `Issued At: ${new Date(token.issuedAt * 1000).toISOString()}`;
  const signature = await account.signMessage({ message });
  const res = await post(base, "/api/auth/verify", {
    body: { address: account.address, message, signature, nonce: token },
  });
  return { res, body: await res.json(), setCookie: res.headers.get("set-cookie") ?? "", token };
}

// ═══ PART 1 — the live dev server, real VouchMe ═════════════════════════════════════════════════

console.log(`\n── against ${BASE} (real VouchMe) ──`);

{
  const r = await fetch(BASE);
  const html = await r.text();
  check("the page renders", r.status === 200 && html.includes("Lend"), `${r.status}, ${html.length} bytes`);
}

{
  const r = await post(BASE, "/api/auth/nonce");
  const t = await r.json();
  check(
    "POST /api/auth/nonce issues a signed, expiring challenge",
    r.status === 200 && /^[0-9a-f]{32}$/.test(t.nonce ?? "") && typeof t.sig === "string" && t.expiresAt > t.issuedAt,
    `nonce ${t.nonce}`,
  );
}

{
  const r = await claim(BASE, null, { pool: "starter" });
  const b = await r.json();
  check("claiming without a session is refused", r.status === 401 && b.code === "not_signed_in", `${r.status} ${b.code}`);
}

{
  // A cookie whose payload says "I am this address" and whose signature is nonsense. This is the
  // whole reason the session is HMAC-bound rather than merely httpOnly.
  const payload = Buffer.from(
    JSON.stringify({ address: "0x86e38ef286e38ef286e38ef286e38ef286e38ef2", exp: 2000000000 }),
  ).toString("base64url");
  const r = await claim(BASE, `lend_session=${payload}.deadbeef`, { pool: "prime" });
  const b = await r.json();
  check("a forged session cookie is refused", r.status === 401 && b.code === "not_signed_in", `${r.status} ${b.code}`);
}

let cookie = null;
let usedToken = null;
{
  const { res, body, setCookie, token } = await signIn(BASE);
  usedToken = token;
  cookie = setCookie.split(";")[0];
  check(
    "a real signature over our nonce mints a session",
    res.status === 200 && body.address === account.address && /HttpOnly/i.test(setCookie),
    `${res.status} ${body.address ?? body.error}, HttpOnly`,
  );
}

{
  const message = `replaying\n\nNonce: ${usedToken.nonce}`;
  const signature = await account.signMessage({ message });
  const r = await post(BASE, "/api/auth/verify", {
    body: { address: account.address, message, signature, nonce: usedToken },
  });
  const b = await r.json();
  check("the same nonce cannot be redeemed twice", r.status === 401 && /already used/i.test(b.error ?? ""), b.error);
}

{
  const r = await claim(BASE, cookie, { pool: "starter" });
  const b = await r.json();
  check(
    "a session with insufficient standing is refused SERVER-SIDE",
    r.status === 403 && b.code === "not_qualified" && b.required === "Tier 1",
    `${r.status} ${b.code} — ${b.error}`,
  );
}

{
  // The body names an Orb anchor's address and an anchor-only pool. The recipient is the session
  // address, always, so this changes nothing.
  const r = await claim(BASE, cookie, { pool: "prime", address: "0x86e38ef286e38ef286e38ef286e38ef286e38ef2" });
  const b = await r.json();
  check(
    "an address in the request body does not override the session",
    r.status === 403 && b.code === "not_qualified" && b.required === "Orb anchor",
    `${r.status} ${b.code} — ${b.error}`,
  );
}

{
  const r = await claim(BASE, cookie, { pool: "platinum" });
  const b = await r.json();
  check("an invented pool is refused", r.status === 404 && b.code === "unknown_pool", `${r.status} ${b.code}`);
}

// ═══ PART 2 — a stub VouchMe, so the ALLOW branch of the gate is exercised ══════════════════════

/** Swapped between checks; the app re-reads standing on every claim, so no restart is needed. */
let stubStanding = null;

const stub = createServer((req, res) => {
  const meta = {
    subgraphDeployment: "stub",
    computedAtBlock: 1,
    indexerLagBlocks: 0,
    engineVersion: "stub",
    mode: "fixture",
  };
  if (!stubStanding || !req.url.startsWith("/api/score/")) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: "identity_not_found", message: "no" }, meta }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ data: { ...stubStanding, address: account.address }, meta }));
});
await new Promise((done) => stub.listen(0, "127.0.0.1", done));
const stubUrl = `http://127.0.0.1:${stub.address().port}`;

const member = (tier, score) => ({
  ensName: "test.eth",
  kind: "member",
  base: 20,
  score,
  scoreAtRisk: score,
  tier,
  depth: 1,
  credentialStatus: "active",
  credentialExpiresAt: "2030-01-01T00:00:00.000Z",
});
const anchor = { ...member(2, 100), kind: "anchor", base: 100 };

const SECOND = `http://127.0.0.1:${SECOND_PORT}`;
// `detached` so the whole process group can be signalled at the end. Killing the npx wrapper alone
// leaves the next-server it spawned holding the port, and the next run fails to bind.
const child = spawn("npx", ["next", "start", "--port", String(SECOND_PORT)], {
  cwd: APP_DIR,
  env: { ...process.env, NEXT_DIST_DIR: ".next-build", VOUCHME_API_URL: stubUrl, LEND_TREASURY_PRIVATE_KEY: "" },
  stdio: "ignore",
  detached: true,
});

async function waitFor(url, ms = 30_000) {
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

try {
  console.log(`\n── against ${SECOND} (stub VouchMe at ${stubUrl}, no treasury key) ──`);
  if (!(await waitFor(SECOND))) throw new Error(`second Lend never came up on ${SECOND}`);

  const { setCookie } = await signIn(SECOND);
  const cookie2 = setCookie.split(";")[0];

  stubStanding = member(0, 50);
  {
    const r = await claim(SECOND, cookie2, { pool: "starter" });
    const b = await r.json();
    check("tier 0 qualifies for nothing", r.status === 403 && b.code === "not_qualified", `${r.status} — ${b.error}`);
  }

  stubStanding = member(1, 60);
  {
    const r = await claim(SECOND, cookie2, { pool: "standard" });
    const b = await r.json();
    check("tier 1 does not reach Standard", r.status === 403 && b.required === "Tier 2", `${r.status} — ${b.error}`);
  }
  {
    const r = await claim(SECOND, cookie2, { pool: "starter" });
    const b = await r.json();
    check(
      "tier 1 PASSES the Starter gate, then fails closed on the missing treasury key",
      r.status === 503 && b.code === "not_configured" && b.error.includes("LEND_TREASURY_PRIVATE_KEY"),
      `${r.status} ${b.code} — ${b.error}`,
    );
  }

  stubStanding = member(2, 150);
  {
    const r = await claim(SECOND, cookie2, { pool: "prime" });
    const b = await r.json();
    check(
      "a tier-2 MEMBER is still refused Prime — that pool wants an Orb anchor",
      r.status === 403 && b.required === "Orb anchor",
      `${r.status} — ${b.error}`,
    );
  }

  stubStanding = anchor;
  {
    const r = await claim(SECOND, cookie2, { pool: "prime" });
    const b = await r.json();
    check(
      "an Orb anchor PASSES the Prime gate, then fails closed on the missing treasury key",
      r.status === 503 && b.code === "not_configured" && b.error.includes("LEND_TREASURY_PRIVATE_KEY"),
      `${r.status} ${b.code} — ${b.error}`,
    );
  }

  stubStanding = null; // stub now 404s: VouchMe answers "no such identity"
  {
    const r = await claim(SECOND, cookie2, { pool: "starter" });
    const b = await r.json();
    check("no VouchMe account qualifies for nothing", r.status === 403 && b.code === "not_qualified", `${r.status} ${b.code}`);
  }

  {
    // VouchMe unreachable must deny, and must say so rather than pretending the person has no
    // standing. An outage that reads as "tier 0" is survivable; one that reads as "allow" is not.
    const r = await post(SECOND, "/api/claim", { cookie: cookie2, body: { pool: "starter" } });
    stub.close();
    const r2 = await claim(SECOND, cookie2, { pool: "starter" });
    const b2 = await r2.json();
    check(
      "an unreachable VouchMe denies, and says so",
      r.status === 403 && r2.status === 503 && b2.code === "vouchme_unavailable",
      `${r2.status} ${b2.code}`,
    );
  }
} finally {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  try {
    stub.close();
  } catch {}
}

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
