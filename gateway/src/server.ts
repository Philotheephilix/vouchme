// @aval/gateway — src/server.ts
//
// Hono HTTP server exposing:
//   GET /health              liveness + config sanity check
//   GET /:sender/:data       the ERC-3668 CCIP-Read gateway endpoint
//
// The CCIP-Read URL template ENS resolvers are configured with is
// `{sender}/{data}.json` (ERC-3668 §"Client Lookup protocol"), so `:data`
// arrives with a `.json` suffix that we strip before decoding.

import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { isAddress, isHex, type Address, type Hex } from "viem";
import {
  ADDRESS_BOOK_ADDRESS,
  resolveByName,
  type GatewayConfig,
} from "./context.js";
import {
  decodeCcipRequest,
  encodeAddrResult,
  encodeTextResult,
  MalformedRequestError,
  UnsupportedRecordError,
} from "./resolve.js";
import {
  encodeGatewayResponseBody,
  gatewaySignerAddress,
  loadSignerKeyFromEnv,
  signGatewayResponse,
} from "./sign.js";

function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const url = env.AVAL_SUBGRAPH_URL;
  if (!url) {
    throw new Error("AVAL_SUBGRAPH_URL is not set (see gateway/.env.example)");
  }
  return {
    subgraph: {
      url,
      apiKey: env.GRAPH_API_KEY,
      x402PrivateKey: env.X402_PRIVATE_KEY,
      x402Chain: env.X402_CHAIN,
    },
    ttlMs: env.GATEWAY_SUBGRAPH_TTL_MS ? Number(env.GATEWAY_SUBGRAPH_TTL_MS) : 5000,
  };
}

export function createApp(config: GatewayConfig, signerKey: Hex): Hono {
  const app = new Hono();
  const signerAddress = gatewaySignerAddress(signerKey);
  const ttlSeconds = Number(process.env.GATEWAY_RESPONSE_TTL_SECONDS ?? 30);

  app.get("/health", (c: Context) =>
    c.json({
      status: "ok",
      service: "@aval/gateway",
      signer: signerAddress,
      addressBook: ADDRESS_BOOK_ADDRESS,
      subgraphUrl: config.subgraph.url,
    }),
  );

  // ERC-3668 CCIP-Read gateway endpoint: GET /{sender}/{data}.json
  app.get("/:sender/:data", async (c: Context) => {
    const sender = c.req.param("sender");
    const rawData = c.req.param("data");
    if (sender === undefined || rawData === undefined) {
      return c.json({ message: "missing sender or data path parameter" }, 400);
    }
    const data = (rawData.endsWith(".json") ? rawData.slice(0, -".json".length) : rawData) as Hex;

    if (!isAddress(sender)) {
      return c.json({ message: "invalid sender address" }, 400);
    }
    if (!isHex(data)) {
      return c.json({ message: "invalid data — expected 0x-prefixed calldata" }, 400);
    }

    let decoded;
    try {
      decoded = decodeCcipRequest(data);
    } catch (err) {
      if (err instanceof MalformedRequestError) {
        return c.json({ message: err.message }, 400);
      }
      if (err instanceof UnsupportedRecordError) {
        return c.json({ message: err.message }, 501);
      }
      throw err;
    }

    const resolved = await resolveByName(decoded.name, config);
    if (!resolved) {
      // Per docs/04-ens.md §5.1: a name outside the graph, or deeper than
      // max_depth, simply does not resolve. No such record.
      return c.json({ message: `${decoded.name.labels.join(".")} does not resolve` }, 404);
    }

    const result =
      decoded.kind === "addr"
        ? encodeAddrResult(resolved.address)
        : encodeTextResult(resolved.records[decoded.key ?? ""] ?? "");

    const signed = await signGatewayResponse({
      privateKey: signerKey,
      target: sender as Address,
      request: data,
      result,
      ttlSeconds,
    });

    return c.json({ data: encodeGatewayResponseBody(signed) });
  });

  return app;
}

function main(): void {
  const config = loadConfig();
  const signerKey = loadSignerKeyFromEnv();
  const app = createApp(config, signerKey);

  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? "0.0.0.0";

  serve({ fetch: app.fetch, port, hostname: host }, (info: AddressInfo) => {
    // eslint-disable-next-line no-console
    console.log(`@aval/gateway listening on http://${info.address}:${info.port}`);
  });
}

// Only run the server when this file is executed directly (not when
// imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
