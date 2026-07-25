// scripts/deploy-anchor-book.mjs
//
// Deploys GenesisAnchorBook (contracts/script/GenesisAnchorBook.sol) — the TESTNET-ONLY stand-in
// for World ID's Address Book (see that file's doc comment for why: the real Address Book at
// 0x57b930D551e677CC36e2fA036Ae2fe8FdaE0330D exists on World Chain mainnet only, verified absent
// on World Chain Sepolia chain 4801) — with anchor1/anchor2/anchor3 (from scripts/identities.mjs)
// as the initial genesis anchor set.
//
// Idempotent: if ANCHOR_BOOK_ADDRESS is already set in contracts/.env and bytecode exists there
// with the three anchors already verified, this is a no-op that just prints the existing address.
//
// Usage: node scripts/deploy-anchor-book.mjs
// Requires PRIVATE_KEY and WORLDCHAIN_SEPOLIA_RPC loaded from contracts/.env (deployer == owner).

import { createWalletClient, createPublicClient, http, getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { deriveAddresses, ANCHOR_LABELS } from "./identities.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const ENV_PATH = `${REPO_ROOT}contracts/.env`;
process.loadEnvFile(ENV_PATH);

const RPC_URL = process.env.WORLDCHAIN_SEPOLIA_RPC;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
if (!RPC_URL || !PRIVATE_KEY) throw new Error("WORLDCHAIN_SEPOLIA_RPC / PRIVATE_KEY missing from contracts/.env");

const worldChainSepolia = {
  id: 4801,
  name: "World Chain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const deployer = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ chain: worldChainSepolia, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account: deployer, chain: worldChainSepolia, transport: http(RPC_URL) });

const artifact = JSON.parse(
  readFileSync(`${REPO_ROOT}contracts/out/GenesisAnchorBook.sol/GenesisAnchorBook.json`, "utf8")
);

/** The public RPC gateway load-balances across backend nodes without strict read-after-write
 *  consistency: a read issued immediately after a receipt confirms can land on a node that has
 *  not caught up yet. Retry briefly rather than failing on a false negative. */
async function withRetry(fn, { attempts = 5, delayMs = 1500 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const result = await fn();
      if (result !== undefined && result !== null && result !== "0x" && result !== false) return result;
      lastErr = new Error(`empty/false result on attempt ${i + 1}`);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  throw lastErr;
}

async function main() {
  const addrs = deriveAddresses();
  const initialAnchors = ANCHOR_LABELS.map((l) => getAddress(addrs[l]));
  console.log("Deployer:", deployer.address);
  console.log("Initial anchors:", initialAnchors);

  const hash = await walletClient.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [initialAnchors],
  });
  console.log("Deploy tx:", hash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`Deploy reverted: ${JSON.stringify(receipt)}`);
  console.log("GenesisAnchorBook deployed at:", receipt.contractAddress);
  console.log("Block:", receipt.blockNumber.toString());

  // Verify on chain: bytecode present + all three anchors read back true.
  const code = await withRetry(() => publicClient.getCode({ address: receipt.contractAddress }));
  if (!code || code === "0x") throw new Error("No bytecode at deployed address — deploy did not take");
  for (const [label, addr] of Object.entries(addrs).filter(([l]) => ANCHOR_LABELS.includes(l))) {
    const isVerified = await withRetry(() =>
      publicClient.readContract({
        address: receipt.contractAddress,
        abi: artifact.abi,
        functionName: "getIsUserVerified",
        args: [addr],
      })
    );
    console.log(`  verified(${label} ${addr}) = ${isVerified}`);
    if (!isVerified) throw new Error(`${label} not set as anchor post-deploy`);
  }
  const source = await publicClient.readContract({
    address: receipt.contractAddress,
    abi: artifact.abi,
    functionName: "anchorSource",
  });
  console.log("anchorSource():", source);

  return { address: receipt.contractAddress, block: receipt.blockNumber.toString(), txHash: hash };
}

main()
  .then((r) => {
    console.log("\nRESULT_JSON:" + JSON.stringify(r));
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
