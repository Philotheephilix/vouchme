// scripts/identities.mjs
//
// Deterministic, reproducible test identities for the World Chain Sepolia live scenario.
//
// ── Why not the well-known Anvil/Hardhat mnemonic ───────────────────────────────────────────
// The first version of this file used the famous "test test test ... junk" mnemonic (Foundry's
// `anvil` / Hardhat's default account seed). That was wrong, and live chain data proved it: after
// funding indices 0-3 with 0.01 ETH each, every one of them showed balance 0 and a nonzero nonce
// within seconds — `cast nonce` on 0xf39Fd6...2266 (index 0) came back **8**, and index 1 came
// back **10**, despite this script never having sent a transaction FROM those addresses. Anyone
// can derive that mnemonic's private keys trivially, so public testnets have standing bots that
// watch its addresses and drain any incoming funds on sight. It is "non-secret" in the sense the
// task asked for, but unusable in practice: transactions signed by those keys never get to keep
// their gas money long enough to be spent on purpose.
//
// ── This seed ────────────────────────────────────────────────────────────────────────────────
// A project-specific fixed string, still fully public/non-secret (printed below, and in every
// copy of this repo), but *not* a globally circulated phrase, so it is not already being watched:
//
//     "aval/worldchain-sepolia/live-scenario/v1"
//
// Each identity's private key is `keccak256(SEED + "::" + label)` — a plain deterministic hash
// derivation (not BIP-39/HD; no mnemonic wordlist needed). Reproducible by construction: the same
// label always yields the same key. Throwaway-testnet-only, same as any non-secret seed would be
// — never fund any address derived from it with anything of real value, on any network, ever.
// (And, per the lesson above: assume that once this file is public, *these* addresses are next.)

import { keccak256, toBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const SEED = "aval/worldchain-sepolia/live-scenario/v1";

export const ANCHOR_LABELS = ["anchor1", "anchor2", "anchor3"];
export const MEMBER_LABELS = ["alice", "bob", "carol", "dave"];
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
