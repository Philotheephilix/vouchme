import { privateKeyToAccount } from "viem/accounts";

const BASE = process.env.FIAR_URL ?? "http://localhost:3100";
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

const nonceOf = async () => {
  const r = await fetch(`${BASE}/api/auth/nonce`, { method: "POST" });
  return { status: r.status, token: await r.json() };
};
const verify = (body, cookie) =>
  fetch(`${BASE}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
const borrow = (cookie, body = { item: "drill" }) =>
  fetch(`${BASE}/api/borrow`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

// ── 1. borrow is closed by default ───────────────────────────────────────────
{
  const r = await borrow(null);
  const b = await r.json();
  check("borrow without a session is refused", r.status === 401 && b.code === "not_signed_in", `${r.status} ${b.code}`);
}

// ── 2. forged session cookie ─────────────────────────────────────────────────
{
  const body = Buffer.from(JSON.stringify({ address: "0x0000000000000000000000000000000000000001", exp: 2000000000 })).toString("base64url");
  const r = await borrow(`fiar_session=${body}.deadbeef`);
  check("hand-forged session cookie is refused", r.status === 401, `status ${r.status}`);
}

// ── 3. bad signature ─────────────────────────────────────────────────────────
const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
{
  const { token } = await nonceOf();
  const r = await verify({
    address: account.address,
    message: `fiar.example wants you to sign in.\n\nNonce: ${token.nonce}`,
    signature: "0x" + "11".repeat(65),
    nonce: token,
  });
  check("invalid signature is refused", r.status === 401, `status ${r.status}`);
}

// ── 4. message that does not carry our nonce ─────────────────────────────────
{
  const { token } = await nonceOf();
  const message = `fiar.example wants you to sign in.\n\nNonce: 00000000000000000000000000000000`;
  const signature = await account.signMessage({ message });
  const r = await verify({ address: account.address, message, signature, nonce: token });
  const b = await r.json();
  check("valid signature over the WRONG nonce is refused", r.status === 401, b.error);
}

// ── 5. happy path (EOA, ecrecover branch) ────────────────────────────────────
let cookie = null;
let usedToken = null;
{
  const { token } = await nonceOf();
  usedToken = token;
  const message = `fiar.example wants you to sign in with your account.\n\nURI: http://localhost:3100\nVersion: 1\nNonce: ${token.nonce}\nIssued At: ${new Date(token.issuedAt * 1000).toISOString()}`;
  const signature = await account.signMessage({ message });
  const r = await verify({ address: account.address, message, signature, nonce: token });
  const b = await r.json();
  const setCookie = r.headers.get("set-cookie") ?? "";
  cookie = setCookie.split(";")[0];
  check("real signature over our nonce mints a session", r.status === 200 && b.address === account.address, `${r.status} ${b.address ?? b.error}`);
  check("session cookie is HttpOnly", /HttpOnly/i.test(setCookie), setCookie.slice(0, 60) + "…");
}

// ── 6. nonce replay ──────────────────────────────────────────────────────────
{
  const message = `replaying\n\nNonce: ${usedToken.nonce}`;
  const signature = await account.signMessage({ message });
  const r = await verify({ address: account.address, message, signature, nonce: usedToken });
  const b = await r.json();
  check("the same nonce cannot be redeemed twice", r.status === 401 && /already used/i.test(b.error ?? ""), b.error);
}

// ── 7. borrow with the real session ──────────────────────────────────────────
{
  const r = await borrow(cookie);
  const b = await r.json();
  check(
    "signed-in borrow reprices server-side under the SESSION address",
    r.status === 403 && b.code === "over_ceiling",
    `${r.status} ${b.code} — this EOA has no VouchMe standing, so ceiling $${b.quote?.ceilingUsd} < $180 drill`,
  );
}

// ── 8. cheapest item, and the price seal ─────────────────────────────────────
{
  const r = await borrow(cookie, { item: "table" });
  const b = await r.json();
  const ok = r.status === 200 && typeof b.authorization === "string" && b.quote.depositUsd === 140;
  check("an item within the ceiling authorizes and returns a sealed price", ok, `${r.status} deposit $${b.quote?.depositUsd} auth=${String(b.authorization).slice(0, 24)}…`);
}

// ── 9. client-claimed price is not trusted ───────────────────────────────────
{
  const r = await borrow(cookie, { item: "table", expectedDepositCents: 100 });
  const b = await r.json();
  check("a client-posted price that disagrees with the server is rejected", r.status === 409 && b.code === "price_moved", `${r.status} ${b.code}`);
}

// ── 10. address in the body cannot override the session ──────────────────────
{
  const r = await borrow(cookie, { item: "table", address: "0x86e38ef286e38ef286e38ef286e38ef286e38ef2", subject: "anchor1.vouchme.eth" });
  const b = await r.json();
  check("an address in the request body does not override the session", r.status === 200 && b.subject.toLowerCase() === account.address.toLowerCase(), `subject ${b.subject}`);
}

// ── 11. the borrow response opens a real payment ─────────────────────────────
let openedReference = null;
{
  const r = await borrow(cookie, { item: "table" });
  const b = await r.json();
  openedReference = b.payment?.reference ?? null;
  const p = b.payment ?? {};
  check(
    "borrow opens a payment for a fixed WLD settlement, separate from the deposit",
    r.status === 200 && p.amountWld === 0.01 && p.isDemoAmount === true && b.quote.depositUsd === 140,
    `settle ${p.amountWld} WLD, quoted deposit $${b.quote?.depositUsd}, to ${p.to}`,
  );
  check("the payment reference is server-minted and alphanumeric", /^[a-z0-9]{32}$/.test(openedReference ?? ""), String(openedReference));
}

// ── 12. confirmation cannot be faked ─────────────────────────────────────────
const confirm = (cookie, body) =>
  fetch(`${BASE}/api/pay/confirm`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

{
  const r = await confirm(null, { reference: openedReference, transaction_id: "0xdeadbeef" });
  const b = await r.json();
  check("confirming without a session is refused", r.status === 401 && b.code === "not_signed_in", `${r.status} ${b.code}`);
}
{
  const r = await confirm(cookie, { reference: "notarealreference00000000000000", transaction_id: "0xdeadbeef" });
  const b = await r.json();
  check("an unknown reference cannot be confirmed", r.status === 404 && b.code === "unknown_reference", `${r.status} ${b.code}`);
}
{
  // A real reference plus a transaction id the Developer Portal has never heard of. This is the
  // exact shape of "client claims it paid" — and it must not become a paid deposit.
  const r = await confirm(cookie, { reference: openedReference, transaction_id: "0x" + "ab".repeat(32) });
  const b = await r.json();
  check(
    "a real reference with a bogus transaction id is NOT marked paid",
    r.status === 409 && b.code === "not_confirmed" && b.paid !== true,
    `${r.status} ${b.code} — ${b.error}`,
  );
}
{
  // The failed attempt above must NOT have retired the reference: a payment still in the mempool
  // has to stay checkable.
  const r = await confirm(cookie, { reference: openedReference, transaction_id: "0x" + "cd".repeat(32) });
  const b = await r.json();
  check("a reference survives a failed confirmation so it can be retried", r.status === 409 && b.code === "not_confirmed", `${r.status} ${b.code}`);
}

console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
process.exit(results.every((r) => r.pass) ? 0 : 1);
