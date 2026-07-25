#!/usr/bin/env node
/**
 * Give carol a third voucher so the live graph demonstrates the full ladder under base 20.
 *
 * WHY
 * ---
 * At base 20 / T1 55, carol sits at 50.00 Tier 0 with two depth-1 vouchers:
 *     20 + min(60x0.25,20) + min(60x0.25,20) = 20 + 15 + 15 = 50 < 55
 * — the "two vouches is never enough from ordinary members, three is" rule doing its
 * job. Without a third voucher the live graph shows no promoted depth-2 account.
 *
 * A third depth-1 voucher fixes it: 20 + 15x3 = 65 >= 55 -> Tier 1.
 *
 * WHY IT TAKES FIVE NEW ACCOUNTS
 * ------------------------------
 * Vouching is rate limited to one per voucher per 24h, and every existing anchor
 * and member already spent today's vouch. So the third voucher has to be a NEW
 * depth-1 member, which in turn needs TWO anchors to create it — and those anchors
 * must themselves be new, because the existing four are rate limited too.
 *
 *     anchor5 ─┐
 *              ├─> erin (depth 1, 20 + 20 + 20 = 60, Tier 1) ──> carol
 *     anchor6 ─┘
 *
 * The rate limit is not an obstacle to work around: it is the same mechanism that
 * makes a collusion ring impossible to bootstrap in one session.
 *
 * Idempotent: every step checks chain state and skips if already done.
 */

import { createPublicClient, createWalletClient, http, keccak256, toBytes, parseEther, formatEther } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveKey } from './identities.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const D = JSON.parse(readFileSync(join(HERE, '../deployments/worldchain-sepolia.json'), 'utf8'));
const REGISTRY = D.contracts.AvalRegistry.address;
const BOOK = D.contracts.GenesisAnchorBook.address;

const chain = { id: 4801, name: 'World Chain Sepolia', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [D.rpcUrl] } } };
const pub = createPublicClient({ chain, transport: http(D.rpcUrl) });

const deployer = privateKeyToAccount(process.env.PRIVATE_KEY);
const deployerWallet = createWalletClient({ account: deployer, chain, transport: http(D.rpcUrl) });

const registryAbi = JSON.parse(readFileSync(join(HERE, '../contracts/out/AvalRegistry.sol/AvalRegistry.json'), 'utf8')).abi;
const bookAbi = JSON.parse(readFileSync(join(HERE, '../contracts/out/GenesisAnchorBook.sol/GenesisAnchorBook.json'), 'utf8')).abi;

const domain = () => ({ name: 'AvalRegistry', version: '1', chainId: 4801n, verifyingContract: REGISTRY });
const freshNonce = () => BigInt(keccak256(toBytes(`promote-${Date.now()}-${Math.random()}`)));
const deadline = async () => (await pub.getBlock()).timestamp + 280n;
const wait = (hash) => pub.waitForTransactionReceipt({ hash });

const acct = (label) => privateKeyToAccount(deriveKey(label));
const walletFor = (label) => createWalletClient({ account: acct(label), chain, transport: http(D.rpcUrl) });

async function fund(label) {
  const a = acct(label).address;
  const bal = await pub.getBalance({ address: a });
  if (bal >= parseEther('0.003')) { console.log(`fund     ${label.padEnd(8)} SKIP (${formatEther(bal)} ETH)`); return; }
  const h = await deployerWallet.sendTransaction({ to: a, value: parseEther('0.01') });
  await wait(h);
  console.log(`fund     ${label.padEnd(8)} 0.01 ETH  ${h}`);
}

async function makeAnchor(label) {
  const a = acct(label).address;
  const is = await pub.readContract({ address: BOOK, abi: bookAbi, functionName: 'getIsUserVerified', args: [a] });
  if (is) { console.log(`anchor   ${label.padEnd(8)} SKIP (already genesis anchor)`); return; }
  const h = await deployerWallet.writeContract({ address: BOOK, abi: bookAbi, functionName: 'setAnchor', args: [a, true] });
  await wait(h);
  console.log(`anchor   ${label.padEnd(8)} set       ${h}`);
}

async function enroll(label, orb) {
  const a = acct(label).address;
  if (await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'isEnrolled', args: [a] })) {
    console.log(`enroll   ${label.padEnd(8)} SKIP (already enrolled)`); return;
  }
  const dl = await deadline(), n = freshNonce();
  const nullifier = BigInt(keccak256(toBytes(`aval-livescenario-nullifier:${label}`)));
  const cred = keccak256(toBytes(orb ? 'orb' : 'selfie-check'));
  const sig = await deployer.signTypedData({
    domain: domain(),
    types: { EnrollAttestation: [
      { name: 'account', type: 'address' }, { name: 'nullifierHash', type: 'uint256' },
      { name: 'credential', type: 'bytes32' }, { name: 'deadline', type: 'uint64' }, { name: 'nonce', type: 'uint256' }] },
    primaryType: 'EnrollAttestation',
    message: { account: a, nullifierHash: nullifier, credential: cred, deadline: dl, nonce: n },
  });
  const h = await walletFor(label).writeContract({ address: REGISTRY, abi: registryAbi, functionName: 'enroll',
    args: [nullifier, cred, label, dl, n, sig] });
  await wait(h);
  console.log(`enroll   ${label.padEnd(8)} ${h}`);
}

async function vouch(from, to, tier) {
  const f = acct(from).address, t = acct(to).address;
  if (await pub.readContract({ address: REGISTRY, abi: registryAbi, functionName: 'isActiveVoucher', args: [f, t] })) {
    console.log(`vouch    ${from} -> ${to.padEnd(7)} SKIP (already active)`); return;
  }
  const dl = await deadline(), n = freshNonce();
  const sig = await deployer.signTypedData({
    domain: domain(),
    types: { VouchAttestation: [
      { name: 'voucher', type: 'address' }, { name: 'vouchee', type: 'address' },
      { name: 'voucherTier', type: 'uint8' }, { name: 'deadline', type: 'uint64' }, { name: 'nonce', type: 'uint256' }] },
    primaryType: 'VouchAttestation',
    message: { voucher: f, vouchee: t, voucherTier: tier, deadline: dl, nonce: n },
  });
  const h = await walletFor(from).writeContract({ address: REGISTRY, abi: registryAbi, functionName: 'vouch',
    args: [t, tier, dl, n, sig] });
  const r = await wait(h);
  console.log(`vouch    ${from} -> ${to.padEnd(7)} ${r.status}  ${h}`);
}

for (const l of ['anchor5', 'anchor6', 'erin']) await fund(l);
for (const l of ['anchor5', 'anchor6']) await makeAnchor(l);
for (const l of ['anchor5', 'anchor6', 'erin']) await enroll(l, l.startsWith('anchor'));
await vouch('anchor5', 'erin', 2);
await vouch('anchor6', 'erin', 2);
await vouch('erin', 'carol', 1);

console.log(`
Expected after this lands:
  erin   20 + 20 + 20      = 60.00  Tier 1  depth 1   (2 anchors)
  carol  20 + 15 + 15 + 15 = 65.00  Tier 1  depth 2   (3 depth-1 vouchers)
         ^ three is enough; two was not`);
