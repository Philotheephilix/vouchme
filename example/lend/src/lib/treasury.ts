import "server-only";

import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseUnits,
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

/**
 * The payout.
 *
 * Fiar takes money from the user with `MiniKit.pay`, so World App holds the key and Fiar only has
 * to check what happened. Lend goes the other way — treasury to user — and there is no MiniKit
 * command for that. The server holds a key and signs an ERC-20 transfer itself, which is a
 * different class of thing to get wrong, so everything here fails closed and refuses loudly.
 *
 * Verified on chain: WLD on World Chain mainnet is 18 decimals, symbol WLD.
 */

/** WLD on World Chain mainnet. */
export const WLD_TOKEN: Address = "0x2cFc85d8E48F8EAB294be644d9E25C3030863003";
export const WLD_DECIMALS = 18;

const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export class TreasuryConfigError extends Error {}

/**
 * A refusal a caller can turn into an HTTP status and a short sentence. Never a thrown string.
 *
 * The codes split on one question the caller has to answer differently: could this have reached the
 * chain? Everything except `send_failed` happened strictly before `writeContract` was called, so
 * nothing was broadcast and the caller may safely give the claim slot back. `send_failed` means the
 * broadcast itself threw — which usually means it never left, but an RPC that times out after the
 * node accepted the transaction looks identical from here. The slot stays taken.
 */
export interface PayoutFailure {
  code: "not_configured" | "insufficient_wld" | "insufficient_gas" | "preflight_failed" | "send_failed";
  status: number;
  message: string;
}

/** True when the failure provably happened before anything could be broadcast. */
export function isPreBroadcast(failure: PayoutFailure): boolean {
  return failure.code !== "send_failed";
}

export type PayoutResult = { ok: true; txHash: `0x${string}` } | { ok: false; failure: PayoutFailure };

function chain(): Chain {
  const id = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? "480");
  const rpcUrl = process.env.WORLDCHAIN_RPC ?? "https://worldchain-mainnet.g.alchemy.com/public";
  return {
    id,
    name: id === 480 ? "World Chain" : "World Chain Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
}

interface Treasury {
  account: PrivateKeyAccount;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

let cached: Treasury | null = null;

/**
 * The treasury, or null when no key is configured.
 *
 * Returning null rather than throwing at import time is deliberate: with no key, Lend must still
 * boot, still read scores, still render pools and still evaluate gates. Only claiming stops.
 */
function getTreasury(): Treasury | null {
  if (cached) return cached;
  const key = process.env.LEND_TREASURY_PRIVATE_KEY?.trim();
  if (!key) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new TreasuryConfigError(
      "LEND_TREASURY_PRIVATE_KEY is set but is not a 0x-prefixed 32-byte hex private key.",
    );
  }
  const account = privateKeyToAccount(key as `0x${string}`);
  const c = chain();
  const transport = http(c.rpcUrls.default.http[0]);
  cached = {
    account,
    publicClient: createPublicClient({ chain: c, transport }) as PublicClient,
    walletClient: createWalletClient({ account, chain: c, transport }),
  };
  return cached;
}

export function treasuryConfigured(): boolean {
  try {
    return getTreasury() !== null;
  } catch {
    return false;
  }
}

export function treasuryAddress(): Address | null {
  try {
    return getTreasury()?.account.address ?? null;
  } catch {
    return null;
  }
}

const NOT_CONFIGURED: PayoutFailure = {
  code: "not_configured",
  status: 503,
  message:
    "Payouts are disabled: LEND_TREASURY_PRIVATE_KEY is not set. Set it to a funded World Chain " +
    "wallet key and restart.",
};

/**
 * Send `amountWld` of WLD from the treasury to `to`.
 *
 * Checks both balances first — the token to send and the ETH to pay for sending it — because a
 * transaction submitted knowing it will revert costs gas, produces a hash that looks like success,
 * and tells the user nothing about which of the two ran out.
 *
 * Returns as soon as the transaction is broadcast. The receipt is NOT awaited: the caller has
 * already recorded the claim, and a user should not hold a phone still for a confirmation.
 */
export async function sendWld(to: Address, amountWld: string): Promise<PayoutResult> {
  let treasury: Treasury | null;
  try {
    treasury = getTreasury();
  } catch (err) {
    return {
      ok: false,
      failure: {
        code: "not_configured",
        status: 503,
        message: err instanceof Error ? err.message : NOT_CONFIGURED.message,
      },
    };
  }
  if (!treasury) return { ok: false, failure: NOT_CONFIGURED };

  const { account, publicClient, walletClient } = treasury;
  const amount = parseUnits(amountWld, WLD_DECIMALS);

  let wldBalance: bigint;
  let ethBalance: bigint;
  try {
    [wldBalance, ethBalance] = await Promise.all([
      publicClient.readContract({
        address: WLD_TOKEN,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [account.address],
      }),
      publicClient.getBalance({ address: account.address }),
    ]);
  } catch (err) {
    return {
      ok: false,
      failure: {
        code: "preflight_failed",
        status: 502,
        message: `Could not read treasury balances from ${chain().name}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    };
  }

  if (wldBalance < amount) {
    return {
      ok: false,
      failure: {
        code: "insufficient_wld",
        status: 503,
        message: `Treasury is short of WLD: holds ${formatUnits(wldBalance, WLD_DECIMALS)}, needs ${amountWld}.`,
      },
    };
  }

  // Estimate rather than hardcode a floor: gas on World Chain is cheap but not fixed, and a
  // hardcoded threshold is either wrong today or wrong later.
  let gasCost: bigint;
  try {
    const [gas, fees] = await Promise.all([
      publicClient.estimateContractGas({
        address: WLD_TOKEN,
        abi: ERC20_ABI,
        functionName: "transfer",
        args: [to, amount],
        account,
      }),
      publicClient.estimateFeesPerGas(),
    ]);
    const perGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
    gasCost = (gas * perGas * 5n) / 4n; // 25% headroom for a fee bump between estimate and mine
  } catch (err) {
    return {
      ok: false,
      failure: {
        code: "preflight_failed",
        status: 502,
        message: `Could not estimate gas for the transfer: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  if (ethBalance < gasCost) {
    return {
      ok: false,
      failure: {
        code: "insufficient_gas",
        status: 503,
        message: `Treasury is short of ETH for gas: holds ${formatEther(ethBalance)} ETH, needs about ${formatEther(gasCost)} ETH.`,
      },
    };
  }

  try {
    const txHash = await walletClient.writeContract({
      account,
      chain: chain(),
      address: WLD_TOKEN,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [to, amount],
    });
    return { ok: true, txHash };
  } catch (err) {
    return {
      ok: false,
      failure: {
        code: "send_failed",
        status: 502,
        message:
          `The transfer failed to broadcast, so this claim is held pending a manual check: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}
