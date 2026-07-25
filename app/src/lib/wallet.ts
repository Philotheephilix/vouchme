/**
 * app/src/lib/wallet.ts
 *
 * Plain EIP-1193 wallet connection for the browser-fallback path (outside World App). No wagmi,
 * no RainbowKit — a `custom(window.ethereum)` viem wallet client is enough to request an address,
 * check/switch chain, send a transaction and decode a revert reason. Inside World App, the wizard
 * screens use `MiniKit.sendTransaction`/`MiniKit.walletAuth` instead (native SIWE, batched tx,
 * gas sponsorship) — this module is the fallback, not the primary path.
 */

"use client";

import { createPublicClient, createWalletClient, custom, decodeErrorResult, getAddress, http, type Address, type Hex, type PublicClient } from "viem";
import { KNOWN_ERRORS_ABI, WORLDCHAIN_SEPOLIA, WORLDCHAIN_SEPOLIA_ID } from "./worldchain";

interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (event: string, handler: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, handler: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
  }
}

export class WalletError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WalletError";
    this.code = code;
  }
}

export function hasInjectedProvider(): boolean {
  return typeof window !== "undefined" && !!window.ethereum;
}

function requireProvider(): Eip1193Provider {
  if (!hasInjectedProvider()) {
    throw new WalletError(
      "no_wallet",
      "No wallet extension found. Open this app inside World App, or install a browser wallet " +
        "(e.g. MetaMask) to connect one here.",
    );
  }
  return window.ethereum!;
}

function getWalletClient() {
  return createWalletClient({ chain: WORLDCHAIN_SEPOLIA, transport: custom(requireProvider()) });
}

/** Prompts the wallet's account picker and returns the selected address. */
export async function requestAccount(): Promise<Address> {
  const provider = requireProvider();
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.[0]) throw new WalletError("no_account", "The wallet returned no accounts.");
  return getAddress(accounts[0]);
}

/** Silent check — no prompt. Returns the already-authorized account, or null. */
export async function getAuthorizedAccount(): Promise<Address | null> {
  if (!hasInjectedProvider()) return null;
  try {
    const accounts = (await window.ethereum!.request({ method: "eth_accounts" })) as string[];
    return accounts?.[0] ? getAddress(accounts[0]) : null;
  } catch {
    return null;
  }
}

export async function getChainIdDecimal(): Promise<number> {
  const provider = requireProvider();
  const hex = (await provider.request({ method: "eth_chainId" })) as string;
  return parseInt(hex, 16);
}

/** Switches (or, if the wallet has never seen it, adds) World Chain Sepolia. Never silently
 *  proceeds on the wrong network — a tx signed against the wrong chain either fails outright or,
 *  worse, succeeds against a contract that doesn't exist there. */
export async function ensureWorldChainSepolia(): Promise<void> {
  const provider = requireProvider();
  const current = await getChainIdDecimal();
  if (current === WORLDCHAIN_SEPOLIA_ID) return;
  const chainIdHex = `0x${WORLDCHAIN_SEPOLIA_ID.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: chainIdHex }] });
  } catch (err) {
    const code = (err as { code?: number })?.code;
    if (code === 4902) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainIdHex,
            chainName: WORLDCHAIN_SEPOLIA.name,
            nativeCurrency: WORLDCHAIN_SEPOLIA.nativeCurrency,
            rpcUrls: WORLDCHAIN_SEPOLIA.rpcUrls.default.http,
            blockExplorerUrls: [WORLDCHAIN_SEPOLIA.blockExplorers.default.url],
          },
        ],
      });
    } else {
      throw new WalletError("wrong_network", "Please switch your wallet to World Chain Sepolia (chain 4801) and try again.");
    }
  }
}

/** Sends a transaction from the connected injected wallet and returns the tx hash. Chain-switch
 *  is the caller's responsibility (call `ensureWorldChainSepolia()` first) so the wizard can show
 *  that as its own visible step. */
export async function sendFromInjected(account: Address, to: Address, data: Hex): Promise<Hex> {
  const client = getWalletClient();
  return client.sendTransaction({ account, to, data, chain: WORLDCHAIN_SEPOLIA });
}

/** Best-effort decode of a contract revert into the real Solidity error name
 *  (`NullifierUsed`, `AlreadyEnrolled`, `BadAttestation`, ...) instead of a generic failure
 *  message — requirement: "Surface the real revert reason ... never a generic failure." */
export function decodeRevertReason(err: unknown): string {
  if (err instanceof WalletError) return err.message;
  const e = err as {
    cause?: { data?: Hex; cause?: { data?: Hex } };
    data?: Hex;
    shortMessage?: string;
    message?: string;
  };
  const data = e?.data ?? e?.cause?.data ?? e?.cause?.cause?.data;
  if (data) {
    try {
      const decoded = decodeErrorResult({ abi: KNOWN_ERRORS_ABI, data });
      return decoded.errorName;
    } catch {
      // fall through to shortMessage
    }
  }
  return e?.shortMessage ?? e?.message ?? String(err);
}

let cachedPublicClient: PublicClient | null = null;

export function getPublicClient(): PublicClient {
  if (!cachedPublicClient) {
    cachedPublicClient = createPublicClient({ chain: WORLDCHAIN_SEPOLIA, transport: http(WORLDCHAIN_SEPOLIA.rpcUrls.default.http[0]) });
  }
  return cachedPublicClient;
}

export interface TxOutcome {
  hash: Hex;
  status: "success" | "reverted";
  revertReason?: string;
}

/** Sends from the injected wallet, waits for the receipt, and — on revert — replays the exact
 *  same call at the mined block to recover the real Solidity error name (`NullifierUsed`,
 *  `RateLimited`, `InsufficientTier`, ...) instead of a generic "transaction reverted." Surfacing
 *  the real reason is a hard requirement: "never a generic failure." */
export async function submitFromInjected(account: Address, to: Address, data: Hex): Promise<TxOutcome> {
  const hash = await sendFromInjected(account, to, data);
  const client = getPublicClient();
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status === "success") return { hash, status: "success" };
  let revertReason: string | undefined;
  try {
    await client.call({ account, to, data, blockNumber: receipt.blockNumber });
  } catch (err) {
    revertReason = decodeRevertReason(err);
  }
  return { hash, status: "reverted", revertReason };
}
