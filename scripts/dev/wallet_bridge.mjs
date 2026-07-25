// A tiny local HTTP "wallet" for headless verification: proxies a minimal EIP-1193 surface to a
// real viem wallet client for one identity (derived from scripts/identities.mjs's public, fixed,
// non-secret seed — never a real credential). The browser-side shim (see inject.js) just fetches
// this. Never prints the private key; only derives an account from it in-process.
import http from "node:http";
import { createWalletClient, createPublicClient, http as viemHttp } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveKey } from "/home/ubuntu/projects/lisboa/scripts/identities.mjs";

const LABEL = process.argv[2];
const PORT = Number(process.argv[3] || 8765);
if (!LABEL) {
  console.error("usage: node wallet_bridge.mjs <label> [port]");
  process.exit(1);
}

const RPC_URL = "https://worldchain-sepolia.gateway.tenderly.co";
const CHAIN = {
  id: 4801,
  name: "World Chain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const account = privateKeyToAccount(deriveKey(LABEL));
const walletClient = createWalletClient({ account, chain: CHAIN, transport: viemHttp(RPC_URL) });
const publicClient = createPublicClient({ chain: CHAIN, transport: viemHttp(RPC_URL) });

console.log(`wallet_bridge: label=${LABEL} address=${account.address} port=${PORT}`);

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");
    try {
      const { method, params } = JSON.parse(body);
      let result;
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          result = [account.address];
          break;
        case "eth_chainId":
          result = "0x" + CHAIN.id.toString(16);
          break;
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
          result = null;
          break;
        case "eth_sendTransaction": {
          const tx = params[0];
          const hash = await walletClient.sendTransaction({
            account,
            to: tx.to,
            data: tx.data,
            value: tx.value ? BigInt(tx.value) : undefined,
          });
          result = hash;
          break;
        }
        case "eth_call": {
          result = await publicClient.call({ to: params[0].to, data: params[0].data });
          result = result.data ?? "0x";
          break;
        }
        default:
          throw new Error(`unsupported method: ${method}`);
      }
      res.end(JSON.stringify({ result }));
    } catch (err) {
      res.end(JSON.stringify({ error: { message: err?.shortMessage || err?.message || String(err) } }));
    }
  });
});

server.listen(PORT, () => console.log(`wallet_bridge listening on :${PORT}`));
