// @aval/gateway — src/server.test.ts
//
// Smoke test for the HTTP server (task brief §3: "npm run dev must start
// and serve GET /health without throwing when optional env vars are
// absent. Missing REQUIRED config should fail fast with a clear message
// naming the variable, not a stack trace."). Run with `npm test` after
// `npm run build` (node's built-in test runner).

import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey } from "viem/accounts";
import { gatewaySignerAddress, loadSignerKeyFromEnv } from "./sign.js";
import { createApp, loadConfig, startServer } from "./server.js";

// The only two env vars this server cannot run without — everything else
// in gateway/.env.example has a default or is optional. Kept minimal and
// explicit here (rather than read from ambient process.env) so this test
// exercises exactly the "optional vars absent" case the brief describes.
function requiredEnv(): NodeJS.ProcessEnv {
  return {
    AVAL_SUBGRAPH_URL: "http://127.0.0.1:1/unused-in-this-test",
    GATEWAY_SIGNER_PRIVATE_KEY: generatePrivateKey(),
  };
}

test("loadConfig fails fast, naming the variable, when AVAL_SUBGRAPH_URL is missing", () => {
  assert.throws(() => loadConfig({}), /AVAL_SUBGRAPH_URL/);
});

test("loadSignerKeyFromEnv fails fast, naming the variable, when GATEWAY_SIGNER_PRIVATE_KEY is missing", () => {
  assert.throws(() => loadSignerKeyFromEnv({}), /GATEWAY_SIGNER_PRIVATE_KEY/);
});

test("server starts on a random port and serves a healthy GET /health with only required env set", async () => {
  const env = requiredEnv();
  const config = loadConfig(env);
  const signerKey = loadSignerKeyFromEnv(env);
  const app = createApp(config, signerKey);

  // port: 0 -> OS assigns a free port, so this test never collides with
  // anything else (including a real gateway) already running.
  const { server, port } = await startServer(app, { port: 0, host: "127.0.0.1" });
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);

    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.equal(body.service, "@aval/gateway");
    assert.equal(body.signer, gatewaySignerAddress(signerKey));
    assert.equal(body.subgraphUrl, env.AVAL_SUBGRAPH_URL);
    assert.equal(typeof body.addressBook, "string");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
});
