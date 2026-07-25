#!/usr/bin/env node
// Add a fourth anchor so bob can reach two contributing vouchers.
//
// WHY THIS SCRIPT EXISTS
// ----------------------
// VouchMeRegistry enforces 1 new vouch per voucher per 24h, so 3 anchors cannot supply
// the 4 anchor-vouch-slots alice and bob need in one session (anchor1+anchor2 -> alice,
// anchor1+anchor3 -> bob): by pigeonhole one of the four must fail with RateLimited().
// With only one anchor vouch bob scores 30 and is blocked by gate 2 — the "1 anchor ->
// 30 -> Blocked" row of docs/01-trust-math.md §12.1 — which cascades into carol, since
// bob then contributes min(30*0.25,20)=7.5 instead of 12.5.
//
// A live session cannot skip the rate limit, so it needs a fourth anchor.
//
// Idempotent: every step checks chain state first and skips if already done.

import { createPublicClient, createWalletClient, http, keccak256, toBytes, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveKey } from './identities.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const D = JSON.parse(readFileSync(join(HERE, '../deployments/worldchain-sepolia.json'), 'utf8'));
const REGISTRY = D.contracts.VouchMeRegistry.address;
const BOOK = D.contracts.GenesisAnchorBook.address;
const RPC = D.rpcUrl;

const chain = { id: 4801, name: 'World Chain Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });

const deployer = privateKeyToAccount(process.env.PRIVATE_KEY);
const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(RPC) });

const anchor4 = privateKeyToAccount(deriveKey('anchor4'));
const anchor4Wallet = createWalletClient({ account: anchor4, chain, transport: http(RPC) });

const BOB = privateKeyToAccount(deriveKey('bob')).address;

const registryAbi = JSON.parse(readFileSync(join(HERE, '../contracts/out/VouchMeRegistry.sol/VouchMeRegistry.json'), 'utf8')).abi;
const bookAbi = JSON.parse(readFileSync(join(HERE, '../contracts/out/GenesisAnchorBook.sol/GenesisAnchorBook.json'), 'utf8')).abi;

const domain = () => ({ name: 'VouchMeRegistry', version: '1', chainId: 4801n, verifyingContract: REGISTRY });
const nonce = () => BigInt(keccak256(toBytes(`anchor4-${Date.now()}-${Math.random()}`)));
const deadline = async () => (await pub.getBlock()).timestamp + 280n;

const wait = (hash) => pub.waitForTransactionReceipt({ hash });

console.log(`anchor4  ${anchor4.address}`);
console.log(`bob      ${BOB}\n`);

// ── 1. fund ────────────────────────────────────────────────────────────────
const bal = await pub.getBalance({ address: anchor4.address });
if (bal < parseEther('0.003')) {
  const h = await deployerWallet.sendTransaction({ to: anchor4.address, value: parseEther('0.01') });
  await wait(h);
  console.log(`fund     sent 0.01 ETH  ${h}`);
} else {
  console.log(`fund     SKIP (${formatEther(bal)} ETH)`);
}

// ── 2. mark as genesis anchor ──────────────────────────────────────────────
const isAnchor = await pub.readContract({ address: BOOK, abi: bookAbi, functionName: 'getIsUserVerified', args: [anchor4.address] });
if (!isAnchor) {
  const h = await deployerWallet.writeContract({ address: BOOK, abi: bookAbi, functionName: 'setAnchor', args: [anchor4.address, true] });
  await wait(h);
  console.log(`anchor   set genesis anchor  ${h}`);
} else {
  console.log('anchor   SKIP (already a genesis anchor)');
}

// ── 3. enroll ──────────────────────────────────────────────────────────────
const enrolled = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'isEnrolled', args: [anchor4.address] });
if (!enrolled) {
  const dl = await deadline(), n = nonce();
  const nullifier = BigInt(keccak256(toBytes('vouchme-livescenario-nullifier:anchor4')));
  const cred = keccak256(toBytes('orb'));
  const sig = await deployer.signTypedData({
    domain: domain(),
    types: { EnrollAttestation: [
      { name: 'account', type: 'address' }, { name: 'nullifierHash', type: 'uint256' },
      { name: 'credential', type: 'bytes32' }, { name: 'deadline', type: 'uint64' },
      { name: 'nonce', type: 'uint256' }] },
    primaryType: 'EnrollAttestation',
    message: { account: anchor4.address, nullifierHash: nullifier, credential: cred, deadline: dl, nonce: n },
  });
  const h = await anchor4Wallet.writeContract({ address: REGISTRY, abi: registryAbi, functionName: 'enroll',
    args: [nullifier, cred, 'anchor4', dl, n, sig] });
  await wait(h);
  console.log(`enroll   ${h}`);
} else {
  console.log('enroll   SKIP (already enrolled)');
}

// ── 4. anchor4 vouches bob ─────────────────────────────────────────────────
const active = await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'isActiveVoucher', args: [anchor4.address, BOB] });
if (!active) {
  const dl = await deadline(), n = nonce();
  const sig = await deployer.signTypedData({
    domain: domain(),
    types: { VouchAttestation: [
      { name: 'voucher', type: 'address' }, { name: 'vouchee', type: 'address' },
      { name: 'voucherTier', type: 'uint8' }, { name: 'deadline', type: 'uint64' },
      { name: 'nonce', type: 'uint256' }] },
    primaryType: 'VouchAttestation',
    message: { voucher: anchor4.address, vouchee: BOB, voucherTier: 2, deadline: dl, nonce: n },
  });
  const h = await anchor4Wallet.writeContract({ address: REGISTRY, abi: registryAbi, functionName: 'vouch',
    args: [BOB, 2, dl, n, sig] });
  const r = await wait(h);
  console.log(`vouch    anchor4 -> bob  ${r.status}  ${h}`);
} else {
  console.log('vouch    SKIP (already active)');
}

console.log('\nExpected after this runs:');
console.log('  bob    10 + 20 + 20 = 50.00  Tier 1  (2 contributing anchors)');
console.log('  carol  10 + 12.5 + 12.5 = 35.00  Tier 1  (both parents now at 50)');
