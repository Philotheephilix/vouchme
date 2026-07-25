// scripts/fund-identities.mjs
//
// Funds the 13 deterministic test identities (scripts/identities.mjs) with enough World Chain
// Sepolia ETH to cover their enroll/vouch transactions. Sends from the deployer (PRIVATE_KEY in
// contracts/.env). Idempotent: tops up only accounts under TARGET_BALANCE, skips the rest.

import { createWalletClient, createPublicClient, http, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveAddresses } from "./identities.mjs";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
process.loadEnvFile(`${REPO_ROOT}contracts/.env`);

const RPC_URL = process.env.WORLDCHAIN_SEPOLIA_RPC;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const worldChainSepolia = {
  id: 4801,
  name: "World Chain Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
};

const deployer = privateKeyToAccount(PRIVATE_KEY);
const publicClient = createPublicClient({ chain: worldChainSepolia, transport: http(RPC_URL) });
const walletClient = createWalletClient({ account: deployer, chain: worldChainSepolia, transport: http(RPC_URL) });

const TARGET_BALANCE = parseEther("0.01"); // plenty at ~0.0002 gwei gas price for enroll+vouch calls

async function main() {
  const addrs = deriveAddresses();
  const deployerBalance = await publicClient.getBalance({ address: deployer.address });
  console.log(`Deployer ${deployer.address} balance: ${formatEther(deployerBalance)} ETH\n`);

  for (const [label, address] of Object.entries(addrs)) {
    const balance = await publicClient.getBalance({ address });
    if (balance >= TARGET_BALANCE) {
      console.log(`${label.padEnd(8)} ${address} already has ${formatEther(balance)} ETH — skip`);
      continue;
    }
    const topUp = TARGET_BALANCE - balance;
    const hash = await walletClient.sendTransaction({ to: address, value: topUp });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Funding ${label} reverted: ${hash}`);
    console.log(`${label.padEnd(8)} ${address} funded +${formatEther(topUp)} ETH  tx=${hash}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
