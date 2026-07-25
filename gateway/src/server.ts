// @vouchme/gateway — src/server.ts
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
import { resolveByName, type GatewayConfig } from "./context.js";
import { CHAIN_PROVENANCE, getAnchorBookAddress, getVouchMeRegistryAddress } from "./chain.js";
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

/**
 * No required env var here: there is no deployed VouchMe Subgraph
 * (deployments/worldchain-sepolia.json's own notes), so `chain.rpcUrl` is an OPTIONAL override —
 * chain.ts's own default (Tenderly primary, Alchemy public fallback) is fine for a fresh checkout.
 * Contract addresses and the deployment block come from deployments/worldchain-sepolia.json
 * itself, not from env vars, so there is nothing else required to configure here either. The
 * gateway's only genuinely required config is the signer key (loadSignerKeyFromEnv, below).
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  return {
    chain: { rpcUrl: env.WORLDCHAIN_SEPOLIA_RPC },
    ttlMs: env.GATEWAY_CHAIN_TTL_MS ? Number(env.GATEWAY_CHAIN_TTL_MS) : 5000,
  };
}

export function createApp(config: GatewayConfig, signerKey: Hex): Hono {
  const app = new Hono();
  const signerAddress = gatewaySignerAddress(signerKey);
  const ttlSeconds = Number(process.env.GATEWAY_RESPONSE_TTL_SECONDS ?? 30);

  app.get("/health", (c: Context) => {
    return c.json({
      status: "ok",
      service: "@vouchme/gateway",
      signer: signerAddress,
      chainId: 4801,
      network: "World Chain Sepolia",
      vouchMeRegistry: getVouchMeRegistryAddress(),
      // GenesisAnchorBook — this deployment's testnet stand-in for World ID's Address Book, which
      // does not exist on World Chain Sepolia (deployments/worldchain-sepolia.json). Never
      // reported as the real Address Book — see anchorSource below.
      anchorBook: getAnchorBookAddress(),
      anchorSource: "genesis-testnet",
      subgraphDeployment: CHAIN_PROVENANCE,
    });
  });

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

/**
 * Starts the HTTP server for a given (already-validated) config/signer key.
 * Exported so tests can start the server on an OS-assigned port (`port: 0`)
 * and shut it down cleanly, instead of every test needing its own env vars
 * and a fixed port.
 */
export function startServer(
  app: Hono,
  options: { port?: number | undefined; host?: string | undefined } = {},
): Promise<{ server: ReturnType<typeof serve>; port: number }> {
  const port = options.port ?? Number(process.env.PORT ?? 8787);
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";

  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port, hostname: host }, (info: AddressInfo) => {
      resolve({ server, port: info.port });
    });
  });
}

/**
 * Loads config, builds the app, and starts listening — everything `main()`
 * needs, split out so it can be driven with an explicit `env` map (tests)
 * instead of always reading `process.env` directly.
 */
async function run(env: NodeJS.ProcessEnv = process.env): Promise<{ server: ReturnType<typeof serve>; port: number }> {
  const config = loadConfig(env);
  const signerKey = loadSignerKeyFromEnv(env);
  const app = createApp(config, signerKey);
  const hostname = env.HOST ?? "0.0.0.0";
  const { server, port } = await startServer(app, {
    port: env.PORT ? Number(env.PORT) : undefined,
    host: hostname,
  });
  // eslint-disable-next-line no-console
  console.log(`@vouchme/gateway listening on http://${hostname}:${port}`);
  return { server, port };
}

function main(): void {
  // Required config (GATEWAY_SIGNER_PRIVATE_KEY — the only genuinely required env var; see
  // loadConfig's own doc comment) fails fast with a clear, named-variable message via
  // loadSignerKeyFromEnv above — caught here so a missing var prints one line and exits, instead
  // of Node's default full stack-trace dump for an uncaught exception.
  run().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    // eslint-disable-next-line no-console
    console.error(`@vouchme/gateway failed to start: ${message}`);
    process.exitCode = 1;
  });
}

// Only run the server when this file is executed directly (not when
// imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
