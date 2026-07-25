// scripts/identities.mjs
//
// Deterministic, reproducible test identities for the World Chain Sepolia live scenario.
//
// ── Why not the well-known Anvil/Hardhat mnemonic ───────────────────────────────────────────
// The famous "test test test ... junk" mnemonic (Foundry's `anvil` / Hardhat's default account
// seed) is non-secret but unusable on a public testnet: anyone can derive its private keys
// trivially, so standing bots watch those addresses and drain any incoming funds on sight. Gas
// sent to them never survives long enough to be spent on purpose.
//
// ── This seed ────────────────────────────────────────────────────────────────────────────────
// A project-specific fixed string, still fully public/non-secret (printed below, and in every
// copy of this repo), but *not* a globally circulated phrase, so it is not already being watched:
//
//     "vouchme/worldchain-sepolia/live-scenario/v1"
//
// Each identity's private key is `keccak256(SEED + "::" + label)` — a plain deterministic hash
// derivation (not BIP-39/HD; no mnemonic wordlist needed). Reproducible by construction: the same
// label always yields the same key. Throwaway-testnet-only, same as any non-secret seed would be
// — never fund any address derived from it with anything of real value, on any network, ever.
// (Assume that once this file is public, *these* addresses are watched too.)

import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const SEED = "vouchme/worldchain-sepolia/live-scenario/v1";

// Six anchors, not three: 3 cannot supply 4 anchor-vouch-slots in one day
// (1 vouch/voucher/24h), and anchor5+anchor6 exist to create erin — the third depth-1
// voucher carol needs, since at base 20 / T1 55 two ordinary vouchers are insufficient.
export const ANCHOR_LABELS = ["anchor1", "anchor2", "anchor3", "anchor4", "anchor5", "anchor6"];
export const MEMBER_LABELS = ["alice", "bob", "carol", "dave", "erin"];
export const RING_LABELS = ["ring1", "ring2", "ring3", "ring4", "ring5", "ring6"];

export const LABELS = [...ANCHOR_LABELS, ...MEMBER_LABELS, ...RING_LABELS];

export function deriveKey(label) {
  return keccak256(toBytes(`${SEED}::${label}`));
}

/** @returns {Record<string, import("viem/accounts").LocalAccount>} label -> viem local account */
export function deriveIdentities() {
  /** @type {Record<string, import("viem/accounts").LocalAccount>} */
  const identities = {};
  for (const label of LABELS) {
    identities[label] = privateKeyToAccount(deriveKey(label));
  }
  return identities;
}

/** Convenience: label -> address only, no signing capability. */
export function deriveAddresses() {
  const identities = deriveIdentities();
  return Object.fromEntries(Object.entries(identities).map(([label, acct]) => [label, acct.address]));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const addrs = deriveAddresses();
  console.log(`Seed (fixed, non-secret): "${SEED}"`);
  console.log(`Derivation: privateKey(label) = keccak256(SEED + "::" + label)\n`);
  for (const [label, addr] of Object.entries(addrs)) {
    console.log(`${label.padEnd(8)} ${addr}`);
  }
}
