/**
 * scripts/dev/live-ens-vouchme.mts — THROWAWAY verification script (read-mostly + 2 test mints).
 *
 * Deliberately self-contained: it hardcodes every address/derivation instead of importing
 * app/src/lib/ens-core.ts, because a rename pass is rewriting that file concurrently and a
 * verification script must not be able to drift with the thing it verifies.
 *
 *   npx tsx scripts/dev/live-ens-vouchme.mts inspect
 *   npx tsx scripts/dev/live-ens-vouchme.mts mint1
 *   npx tsx scripts/dev/live-ens-vouchme.mts transfer
 *   npx tsx scripts/dev/live-ens-vouchme.mts mint2
 *   npx tsx scripts/dev/live-ens-vouchme.mts resolve
 */
import {
  concat,
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  encodeFunctionData,
  getCreate2Address,
  http,
  keccak256,
  namehash,
  toBytes,
  formatEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { readFileSync } from "node:fs";

const ETH_REGISTRY: Address = "0xDEDB92913A25abE1f7BCDD85D8A344a43B398B67";
const VOUCHME_REGISTRY: Address = "0xb31CD08323fbF0Ef0E660c77A9A38bab3Cb45B36";
const RESOLVER: Address = "0x211D6CC339C7C6E4B4448c04cD034E363d9994d3";
const VERIFIABLE_FACTORY: Address = "0xD2a632D8a8b67c2c4398c255CbD7aF8dd7236198";
const PROXY_LOGIC: Address = "0x917c561a74df398646E06f3ffAA51DB8E8330c5A";
const REGISTRY_IMPL: Address = "0x0F99e7Ea74903AfCB7224d0354fD7428A6f92917";
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n;
const ROLE_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n; // bit 156
const SOULBOUND_ROLES = ALL_ROLES & ~ROLE_CAN_TRANSFER_ADMIN;
const SALT_NS = "aval.eth/member-registry/v1";

const REG_ABI = [
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [{ name: "label", type: "string" }, { name: "owner", type: "address" }, { name: "registry", type: "address" }, { name: "resolver", type: "address" }, { name: "roleBitmap", type: "uint256" }, { name: "expiry", type: "uint64" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "setSubregistry", stateMutability: "nonpayable", inputs: [{ name: "anyId", type: "uint256" }, { name: "registry", type: "address" }], outputs: [] },
  { type: "function", name: "findTokenId", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "findOwner", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "address" }] },
  { type: "function", name: "findExpiry", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "uint64" }] },
  { type: "function", name: "getSubregistry", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "address" }] },
  { type: "function", name: "getResolver", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ type: "address" }] },
  { type: "function", name: "roles", stateMutability: "view", inputs: [{ name: "anyId", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "hasRoles", stateMutability: "view", inputs: [{ name: "anyId", type: "uint256" }, { name: "roleBitmap", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "hasRootRoles", stateMutability: "view", inputs: [{ name: "roleBitmap", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "safeTransferFrom", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "id", type: "uint256" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }, { name: "id", type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "error", name: "TransferDisallowed", inputs: [{ name: "tokenId", type: "uint256" }, { name: "from", type: "address" }] },
] as const;

const RES_ABI = [
  { type: "function", name: "setAddr", stateMutability: "nonpayable", inputs: [{ name: "node", type: "bytes32" }, { name: "a", type: "address" }], outputs: [] },
  { type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ type: "address" }] },
] as const;

const FACTORY_ABI = [
  { type: "function", name: "deployProxy", stateMutability: "nonpayable", inputs: [{ name: "implementation", type: "address" }, { name: "salt", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [{ type: "address" }] },
] as const;

const INIT_ABI = [
  { type: "function", name: "initialize", stateMutability: "nonpayable", inputs: [{ name: "owner", type: "address" }, { name: "roleBitmap", type: "uint256" }], outputs: [] },
] as const;

function env(name: string): string {
  const raw = readFileSync("/home/ubuntu/projects/lisboa/app/.env.local", "utf8");
  for (const line of raw.split("\n")) {
    if (!line.includes("=") || line.trim().startsWith("#")) continue;
    const k = line.slice(0, line.indexOf("=")).trim();
    if (k === name) return line.slice(line.indexOf("=") + 1).trim();
  }
  throw new Error(`${name} not in app/.env.local`);
}

// tenderly's public gateway answers reads fine but rejects eth_sendRawTransaction
// ("Request exceeds defined limit"), so writes go through the configured RPC.
const RPC = process.env.RPC_OVERRIDE ?? env("ETH_SEPOLIA_RPC");
const pk = env("DEPLOYER_PRIVATE_KEY");
const account = privateKeyToAccount((pk.startsWith("0x") ? pk : `0x${pk}`) as Hex);
const pub = createPublicClient({ chain: sepolia, transport: http(RPC) });
const wallet = createWalletClient({ account, chain: sepolia, transport: http(RPC) });
/** A brand-new client for read-backs — never the one that did the writing. */
const fresh = () => createPublicClient({ chain: sepolia, transport: http(RPC) });

const salt = (label: string) => BigInt(keccak256(toBytes(`${SALT_NS}::${label}`)));
function predict(label: string, deployer: Address): Address {
  const outer = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [deployer, salt(label)]));
  const creation = concat(["0x3d604d80600a3d3981f3363d3d373d3d3d363d73", PROXY_LOGIC, "0x5af43d82803e903d91602b57fd5bf3", outer]);
  return getCreate2Address({ from: VERIFIABLE_FACTORY, salt: outer, bytecodeHash: keccak256(creation) });
}
const codeLen = async (a: Address) => (a === ZERO ? 0 : (((await pub.getCode({ address: a })) ?? "0x").length - 2) / 2);

/** Deterministic non-secret test targets, so the expected addr() value is reproducible offline. */
const TARGET1 = privateKeyToAccount(keccak256(toBytes("vouchme-livetest1"))).address;
const TARGET2 = privateKeyToAccount(keccak256(toBytes("vouchme-livetest2"))).address;

async function deployClone(label: string): Promise<{ addr: Address; tx: Hex | null }> {
  const addr = predict(label, account.address);
  if ((await codeLen(addr)) > 0) return { addr, tx: null };
  const data = encodeFunctionData({ abi: INIT_ABI, functionName: "initialize", args: [account.address, SOULBOUND_ROLES] });
  const tx = await wallet.writeContract({ address: VERIFIABLE_FACTORY, abi: FACTORY_ABI, functionName: "deployProxy", args: [REGISTRY_IMPL, salt(label), data] });
  const r = await pub.waitForTransactionReceipt({ hash: tx });
  if (r.status !== "success") throw new Error(`deployProxy reverted ${tx}`);
  console.log(`   deployProxy       tx=${tx}  block=${r.blockNumber}  -> ${addr}`);
  return { addr, tx };
}

async function inspect() {
  console.log(`RPC ${RPC}   chainId ${await pub.getChainId()}   head block ${await pub.getBlockNumber()}`);
  console.log(`deployer ${account.address}  balance ${formatEther(await pub.getBalance({ address: account.address }))} SepoliaETH\n`);

  const owner = await pub.readContract({ address: ETH_REGISTRY, abi: REG_ABI, functionName: "findOwner", args: ["vouchme"] });
  const sub = await pub.readContract({ address: ETH_REGISTRY, abi: REG_ABI, functionName: "getSubregistry", args: ["vouchme"] });
  const expiry = await pub.readContract({ address: ETH_REGISTRY, abi: REG_ABI, functionName: "findExpiry", args: ["vouchme"] });
  console.log(`.eth registry            ${ETH_REGISTRY}`);
  console.log(`findOwner("vouchme")     ${owner}   ${owner.toLowerCase() === account.address.toLowerCase() ? "== deployer" : "!! NOT deployer"}`);
  console.log(`getSubregistry("vouchme")${sub}   expected 0xb31CD08323fbF0Ef0E660c77A9A38bab3Cb45B36  match=${sub.toLowerCase() === VOUCHME_REGISTRY.toLowerCase()}`);
  console.log(`eth_getCode(${sub})  ${await codeLen(sub)} bytes`);
  console.log(`findExpiry("vouchme")    ${expiry}  (${new Date(Number(expiry) * 1000).toISOString()})\n`);

  const rootRoles = (await pub.readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "roles", args: [0n, account.address] })) as bigint;
  const hasTransfer = await pub.readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "hasRootRoles", args: [ROLE_CAN_TRANSFER_ADMIN, account.address] });
  console.log(`ROOT_RESOURCE roles(0, deployer) on ${VOUCHME_REGISTRY}`);
  console.log(`  = 0x${rootRoles.toString(16).padStart(64, "0")}`);
  console.log(`  ALL_ROLES         0x${ALL_ROLES.toString(16)}`);
  console.log(`  SOULBOUND_ROLES   0x${SOULBOUND_ROLES.toString(16)}   match=${rootRoles === SOULBOUND_ROLES}`);
  console.log(`  ROLE_CAN_TRANSFER_ADMIN = (1<<28)<<128 = 1<<156 = 0x${ROLE_CAN_TRANSFER_ADMIN.toString(16)}`);
  console.log(`  rootRoles & ROLE_CAN_TRANSFER_ADMIN = ${(rootRoles & ROLE_CAN_TRANSFER_ADMIN).toString()}  -> bit ${(rootRoles & ROLE_CAN_TRANSFER_ADMIN) === 0n ? "CLEAR (soulbound)" : "SET (TRANSFERABLE)"}`);
  console.log(`  hasRootRoles(ROLE_CAN_TRANSFER_ADMIN, deployer) = ${hasTransfer}`);
}

async function mint1() {
  const label = "livetest1";
  console.log(`── mint ${label}.vouchme.eth -> ${TARGET1}`);
  const clone = await deployClone(label);
  console.log(`   own registry      ${clone.addr}  (${clone.tx ? "deployed now" : "already present"})  code=${await codeLen(clone.addr)}B`);

  const owner = await pub.readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "findOwner", args: [label] });
  if (owner === ZERO) {
    const parentExpiry = (await pub.readContract({ address: ETH_REGISTRY, abi: REG_ABI, functionName: "findExpiry", args: ["vouchme"] })) as bigint;
    const want = BigInt(Math.floor(Date.now() / 1000)) + 365n * 24n * 3600n;
    const expiry = want < parentExpiry ? want : parentExpiry - 60n;
    const tx = await wallet.writeContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "register", args: [label, account.address, clone.addr, RESOLVER, SOULBOUND_ROLES, expiry] });
    const r = await pub.waitForTransactionReceipt({ hash: tx });
    if (r.status !== "success") throw new Error(`register reverted ${tx}`);
    console.log(`   register          tx=${tx}  block=${r.blockNumber}  gas=${r.gasUsed}  expiry=${expiry}`);
  } else {
    console.log(`   register          skipped, already owned by ${owner}`);
  }

  const node = namehash(`${label}.vouchme.eth`);
  const cur = await pub.readContract({ address: RESOLVER, abi: RES_ABI, functionName: "addr", args: [node] });
  if (cur.toLowerCase() !== TARGET1.toLowerCase()) {
    const tx = await wallet.writeContract({ address: RESOLVER, abi: RES_ABI, functionName: "setAddr", args: [node, TARGET1] });
    const r = await pub.waitForTransactionReceipt({ hash: tx });
    if (r.status !== "success") throw new Error(`setAddr reverted ${tx}`);
    console.log(`   setAddr           tx=${tx}  block=${r.blockNumber}`);
  } else console.log(`   setAddr           skipped, already ${cur}`);

  // ── read back with a FRESH client ──
  const f = fresh();
  const addr = await f.readContract({ address: RESOLVER, abi: RES_ABI, functionName: "addr", args: [node] });
  const sub = await f.readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "getSubregistry", args: [label] });
  const tokenId = (await f.readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "findTokenId", args: [label] })) as bigint;
  const own = await f.readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "findOwner", args: [label] });
  const transferable = await f.readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "hasRoles", args: [tokenId, ROLE_CAN_TRANSFER_ADMIN, own] });
  console.log(`\n   FRESH-CLIENT READ-BACK (namehash ${node})`);
  console.log(`   addr("${label}.vouchme.eth") = ${addr}  expected ${TARGET1}  match=${addr.toLowerCase() === TARGET1.toLowerCase()}`);
  console.log(`   getSubregistry("${label}")   = ${sub}  code=${await codeLen(sub as Address)}B  match=${(sub as string).toLowerCase() === clone.addr.toLowerCase()}`);
  console.log(`   owner=${own}  tokenId=${tokenId}`);
  console.log(`   hasRoles(tokenId, ROLE_CAN_TRANSFER_ADMIN, owner) = ${transferable}  -> soulbound=${!transferable}`);
}

async function transfer() {
  const label = "livetest1";
  const tokenId = (await pub.readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "findTokenId", args: [label] })) as bigint;
  const owner = (await pub.readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "findOwner", args: [label] })) as Address;
  const bal = await pub.readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "balanceOf", args: [owner, tokenId] });
  const to: Address = "0x000000000000000000000000000000000000dEaD";
  console.log(`── safeTransferFrom(${owner}, ${to}, ${tokenId}, 1, 0x) on ${VOUCHME_REGISTRY}`);
  console.log(`   balanceOf(owner, tokenId) = ${bal}   (the token really is held by the caller)\n`);

  console.log(`1) eth_call simulation:`);
  try {
    await pub.simulateContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "safeTransferFrom", args: [owner, to, tokenId, 1n, "0x"], account });
    console.log(`   !!!! SIMULATION SUCCEEDED — THE TOKEN IS TRANSFERABLE, NOT SOULBOUND`);
    process.exitCode = 1;
    return;
  } catch (e: any) {
    const name = e?.cause?.data?.errorName ?? e?.walk?.()?.data?.errorName;
    const args = e?.cause?.data?.args ?? e?.walk?.()?.data?.args;
    console.log(`   REVERTED. decoded custom error: ${name ?? "(undecoded)"}${args ? `(${args.join(", ")})` : ""}`);
    const raw = String(e?.cause?.raw ?? e?.details ?? "");
    if (raw) console.log(`   raw revert data: ${raw}`);
    console.log(`   selector check: keccak256("TransferDisallowed(uint256,address)")[0:4] = ${keccak256(toBytes("TransferDisallowed(uint256,address)")).slice(0, 10)}`);
    if (name !== "TransferDisallowed") {
      console.log(`   !!!! reverted with something OTHER than TransferDisallowed`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`\n2) real broadcast transaction (gas forced past estimation so the revert lands on chain):`);
  const data = encodeFunctionData({ abi: REG_ABI, functionName: "safeTransferFrom", args: [owner, to, tokenId, 1n, "0x"] });
  const hash = await wallet.sendTransaction({ to: VOUCHME_REGISTRY, data, gas: 200_000n });
  console.log(`   tx ${hash}`);
  const r = await pub.waitForTransactionReceipt({ hash });
  console.log(`   block=${r.blockNumber}  status=${r.status}  gasUsed=${r.gasUsed}`);
  if (r.status !== "reverted") { console.log(`   !!!! ON-CHAIN TRANSFER SUCCEEDED — NOT SOULBOUND`); process.exitCode = 1; return; }

  const stillOwner = await fresh().readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "findOwner", args: [label] });
  const deadBal = await fresh().readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "balanceOf", args: [to, tokenId] });
  console.log(`   after: findOwner("${label}") = ${stillOwner}  (unchanged=${stillOwner.toLowerCase() === owner.toLowerCase()})   balanceOf(0x…dEaD)=${deadBal}`);
}

async function mint2() {
  const parentLabel = "livetest1", label = "livetest2";
  const parentReg = (await pub.readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "getSubregistry", args: [parentLabel] })) as Address;
  console.log(`── mint ${label}.${parentLabel}.vouchme.eth inside ${parentLabel}'s own registry ${parentReg}`);
  if ((await codeLen(parentReg)) === 0) throw new Error("parent has no registry");
  const clone = await deployClone(label);
  console.log(`   ${label} registry  ${clone.addr}  code=${await codeLen(clone.addr)}B`);

  const owner = await pub.readContract({ address: parentReg, abi: REG_ABI, functionName: "findOwner", args: [label] });
  if (owner === ZERO) {
    const pExp = (await pub.readContract({ address: VOUCHME_REGISTRY, abi: REG_ABI, functionName: "findExpiry", args: [parentLabel] })) as bigint;
    const want = BigInt(Math.floor(Date.now() / 1000)) + 90n * 24n * 3600n;
    const expiry = want < pExp ? want : pExp - 60n;
    const tx = await wallet.writeContract({ address: parentReg, abi: REG_ABI, functionName: "register", args: [label, account.address, clone.addr, RESOLVER, SOULBOUND_ROLES, expiry] });
    const r = await pub.waitForTransactionReceipt({ hash: tx });
    if (r.status !== "success") throw new Error(`register reverted ${tx}`);
    console.log(`   register          tx=${tx}  block=${r.blockNumber}  gas=${r.gasUsed}`);
  } else console.log(`   register          skipped, owned by ${owner}`);

  const fq = `${label}.${parentLabel}.vouchme.eth`;
  const node = namehash(fq);
  const cur = await pub.readContract({ address: RESOLVER, abi: RES_ABI, functionName: "addr", args: [node] });
  if (cur.toLowerCase() !== TARGET2.toLowerCase()) {
    const tx = await wallet.writeContract({ address: RESOLVER, abi: RES_ABI, functionName: "setAddr", args: [node, TARGET2] });
    const r = await pub.waitForTransactionReceipt({ hash: tx });
    if (r.status !== "success") throw new Error(`setAddr reverted ${tx}`);
    console.log(`   setAddr           tx=${tx}  block=${r.blockNumber}`);
  } else console.log(`   setAddr           skipped, already ${cur}`);

  const f = fresh();
  const tokenId = (await f.readContract({ address: parentReg, abi: REG_ABI, functionName: "findTokenId", args: [label] })) as bigint;
  const own = (await f.readContract({ address: parentReg, abi: REG_ABI, functionName: "findOwner", args: [label] })) as Address;
  const transferable = await f.readContract({ address: parentReg, abi: REG_ABI, functionName: "hasRoles", args: [tokenId, ROLE_CAN_TRANSFER_ADMIN, own] });
  console.log(`\n   FRESH-CLIENT READ-BACK  addr("${fq}") = ${await f.readContract({ address: RESOLVER, abi: RES_ABI, functionName: "addr", args: [node] })}  expected ${TARGET2}`);
  console.log(`   hasRoles(tokenId, ROLE_CAN_TRANSFER_ADMIN, owner) = ${transferable}  -> soulbound=${!transferable}`);
}

/** Walk the registry chain hop by hop from the .eth registry down, then resolve the leaf. */
async function resolve() {
  const name = process.argv[3] ?? "livetest2.livetest1.vouchme.eth";
  const f = fresh();
  const parts = name.split(".");
  if (parts.at(-1) !== "eth") throw new Error("expect .eth");
  let cur: Address = ETH_REGISTRY, path = "eth";
  for (const l of parts.slice(0, -1).reverse()) {
    const owner = await f.readContract({ address: cur, abi: REG_ABI, functionName: "findOwner", args: [l] });
    const sub = (await f.readContract({ address: cur, abi: REG_ABI, functionName: "getSubregistry", args: [l] })) as Address;
    const res = await f.readContract({ address: cur, abi: REG_ABI, functionName: "getResolver", args: [l] });
    const exp = await f.readContract({ address: cur, abi: REG_ABI, functionName: "findExpiry", args: [l] });
    path = `${l}.${path}`;
    console.log(`${path.padEnd(32)} parentRegistry=${cur}`);
    console.log(`${" ".repeat(32)} owner=${owner} resolver=${res} expiry=${exp} (${new Date(Number(exp) * 1000).toISOString()})`);
    console.log(`${" ".repeat(32)} getSubregistry("${l}")=${sub} code=${await codeLen(sub)}B`);
    cur = sub;
  }
  const a = await f.readContract({ address: RESOLVER, abi: RES_ABI, functionName: "addr", args: [namehash(name)] });
  console.log(`resolver.addr(namehash("${name}")) = ${a}`);
}

const cmd = process.argv[2];
const fns: Record<string, () => Promise<void>> = { inspect, mint1, transfer, mint2, resolve };
if (!fns[cmd]) { console.log("usage: inspect | mint1 | transfer | mint2 | resolve [name]"); process.exit(1); }
await fns[cmd]().catch((e) => { console.error("FAILED:", e?.shortMessage ?? e?.message ?? e); console.error(String(e).slice(0, 2000)); process.exit(1); });
