/**
 * scripts/dev/ensstate.mjs — one-screen truth about the aval.eth population on Ethereum Sepolia.
 *
 * Prints, per label: who owns the name, what it resolves to, and — the part that decides whether
 * nested vouch names are possible at all — whether the member owns a real `PermissionedRegistry`
 * with actual contract code at it. A non-zero `getSubregistry` with no code is not a registry.
 *
 * Provisioning lives in `ens-provision.mts`; this file only reads.
 */
import { createPublicClient, http, formatEther, namehash } from "viem";
import { sepolia } from "viem/chains";
const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const REG = "0xb8C3d3AD86b0b66CE5401c81e9c4a037DF69eF33";
const RES = "0x211D6CC339C7C6E4B4448c04cD034E363d9994d3";
const DEP = "0x69827C0FEF274C63Ac4806106F2BA544E6129050";
const ZERO = "0x0000000000000000000000000000000000000000";
const c = createPublicClient({ chain: sepolia, transport: http(RPC) });
const regAbi = [
  { type: "function", name: "findOwner", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getSubregistry", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "address" }] },
];
const resAbi = [{ type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "address" }] }];
console.log("deployer balance:", formatEther(await c.getBalance({ address: DEP })), "SepoliaETH");
const labels = ["alice", "bob", "carol", "dave", "erin", "anchor1", "anchor2", "anchor3", "anchor4", "anchor5", "anchor6", "ring1", "ring2", "ring3", "ring4", "ring5", "ring6"];
const missing = [], noRegistry = [], haveName = [];
for (const l of labels) {
  const o = await c.readContract({ address: REG, abi: regAbi, functionName: "findOwner", args: [l] }).catch(() => null);
  const sub = await c.readContract({ address: REG, abi: regAbi, functionName: "getSubregistry", args: [l] }).catch(() => null);
  const a = await c.readContract({ address: RES, abi: resAbi, functionName: "addr", args: [namehash(`${l}.aval.eth`)] }).catch(() => null);
  const code = sub && sub !== ZERO ? await c.getCode({ address: sub }).catch(() => null) : null;
  const codeBytes = code ? (code.length - 2) / 2 : 0;
  if (!o || o === ZERO) { missing.push(l); continue; }
  if (codeBytes === 0) noRegistry.push(l);
  haveName.push(`${l.padEnd(8)} owner=${o.slice(0, 10)} addr=${a && a !== ZERO ? a : "NONE"} registry=${codeBytes ? `${sub} (${codeBytes}B)` : "NONE"}`);
}
console.log("REGISTERED:");
haveName.forEach((x) => console.log("  " + x));
console.log(`MISSING (${missing.length}):`, missing.join(", ") || "—");
console.log(`REGISTERED BUT NO OWN REGISTRY — cannot hold vouch subnames (${noRegistry.length}):`, noRegistry.join(", ") || "—");

// Nested proof: every vouch subname that exists inside a member's own registry.
console.log("\nNESTED (vouch subnames, <vouchee>.<voucher>.aval.eth):");
let nested = 0;
for (const voucher of labels) {
  const vr = await c.readContract({ address: REG, abi: regAbi, functionName: "getSubregistry", args: [voucher] }).catch(() => null);
  if (!vr || vr === ZERO) continue;
  for (const vouchee of labels) {
    const o = await c.readContract({ address: vr, abi: regAbi, functionName: "findOwner", args: [vouchee] }).catch(() => null);
    if (!o || o === ZERO) continue;
    const fq = `${vouchee}.${voucher}.aval.eth`;
    const a = await c.readContract({ address: RES, abi: resAbi, functionName: "addr", args: [namehash(fq)] }).catch(() => null);
    const sub = await c.readContract({ address: vr, abi: regAbi, functionName: "getSubregistry", args: [vouchee] }).catch(() => null);
    console.log(`  ${fq.padEnd(28)} addr=${a && a !== ZERO ? a : "NONE"} childRegistry=${sub && sub !== ZERO ? sub : "NONE"}`);
    nested++;
  }
}
if (nested === 0) console.log("  (none)");
