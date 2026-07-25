import { createPublicClient, http, namehash } from "viem";
import { sepolia } from "viem/chains";

process.loadEnvFile("/home/ubuntu/projects/lisboa/.env");

const RPC = process.env.ETH_SEPOLIA_RPC;
const VOUCHME_REGISTRY = "0xb8C3d3AD86b0b66CE5401c81e9c4a037DF69eF33";
const VOUCHME_RESOLVER = "0x211D6CC339C7C6E4B4448c04cD034E363d9994d3";
const ETH_REGISTRY = "0xDEDB92913A25abE1f7BCDD85D8A344a43B398B67";
const DEPLOYER = "0x69827C0FEF274C63Ac4806106F2BA544E6129050";

const REGISTRY_ABI = [
  { type: "function", name: "findOwner", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getSubregistry", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getResolver", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "findExpiry", stateMutability: "view", inputs: [{ name: "label", type: "string" }], outputs: [{ name: "", type: "uint64" }] },
  { type: "function", name: "hasRoles", stateMutability: "view", inputs: [{ name: "resource", type: "uint256" }, { name: "roleBitmap", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ name: "", type: "bool" }] },
  { type: "function", name: "roles", stateMutability: "view", inputs: [{ name: "resource", type: "uint256" }, { name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
];

const RESOLVER_ABI = [
  { type: "function", name: "addr", stateMutability: "view", inputs: [{ name: "node", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
];

const client = createPublicClient({ chain: sepolia, transport: http(RPC) });

async function main() {
  console.log("ETH_SEPOLIA_RPC:", RPC);

  const subOfVouchMe = await client.readContract({ address: ETH_REGISTRY, abi: REGISTRY_ABI, functionName: "getSubregistry", args: ["vouchme"] });
  console.log("ethRegistry.getSubregistry('vouchme'):", subOfVouchMe, "expected:", VOUCHME_REGISTRY, "match:", subOfVouchMe.toLowerCase() === VOUCHME_REGISTRY.toLowerCase());

  const carolOwner = await client.readContract({ address: VOUCHME_REGISTRY, abi: REGISTRY_ABI, functionName: "findOwner", args: ["carol"] });
  console.log("vouchMeRegistry.findOwner('carol'):", carolOwner);

  const carolResolver = await client.readContract({ address: VOUCHME_REGISTRY, abi: REGISTRY_ABI, functionName: "getResolver", args: ["carol"] });
  console.log("vouchMeRegistry.getResolver('carol'):", carolResolver, "expected:", VOUCHME_RESOLVER);

  const carolExpiry = await client.readContract({ address: VOUCHME_REGISTRY, abi: REGISTRY_ABI, functionName: "findExpiry", args: ["carol"] });
  console.log("vouchMeRegistry.findExpiry('carol'):", carolExpiry.toString());

  const carolAddr = await client.readContract({ address: VOUCHME_RESOLVER, abi: RESOLVER_ABI, functionName: "addr", args: [namehash("carol.vouchme.eth")] });
  console.log("resolver.addr(namehash('carol.vouchme.eth')):", carolAddr);

  // check an UNUSED label is genuinely available
  const testOwner = await client.readContract({ address: VOUCHME_REGISTRY, abi: REGISTRY_ABI, functionName: "findOwner", args: ["zztest001"] });
  console.log("vouchMeRegistry.findOwner('zztest001') (should be zero):", testOwner);

  const rolesBitmap = await client.readContract({ address: VOUCHME_REGISTRY, abi: REGISTRY_ABI, functionName: "roles", args: [0n, DEPLOYER] });
  console.log("vouchMeRegistry.roles(0, deployer):", "0x" + rolesBitmap.toString(16));

  const hasRegistrar = await client.readContract({ address: VOUCHME_REGISTRY, abi: REGISTRY_ABI, functionName: "hasRoles", args: [0n, 1n, DEPLOYER] });
  console.log("vouchMeRegistry.hasRoles(0, ROLE_REGISTRAR=1, deployer):", hasRegistrar);

  const balance = await client.getBalance({ address: DEPLOYER });
  console.log("deployer ETH balance (wei):", balance.toString());
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
