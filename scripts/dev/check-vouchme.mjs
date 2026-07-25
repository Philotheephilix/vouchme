import { createPublicClient, http, namehash } from "viem";
import { sepolia } from "viem/chains";
const RPC = "https://sepolia.gateway.tenderly.co";
const ETH_REGISTRY = "0xDEDB92913A25abE1f7BCDD85D8A344a43B398B67"; // ENSv2 .eth registry
const c = createPublicClient({ chain: sepolia, transport: http(RPC) });
const abi = [
  { type:"function", name:"getSubregistry", stateMutability:"view", inputs:[{name:"label",type:"string"}], outputs:[{type:"address"}] },
  { type:"function", name:"findOwner", stateMutability:"view", inputs:[{name:"label",type:"string"}], outputs:[{type:"address"}] },
];
for (const label of ["vouchme", "aval"]) {
  const owner = await c.readContract({address:ETH_REGISTRY, abi, functionName:"findOwner", args:[label]}).catch(e=>"ERR:"+String(e).slice(0,60));
  const sub   = await c.readContract({address:ETH_REGISTRY, abi, functionName:"getSubregistry", args:[label]}).catch(()=>null);
  const code  = sub && sub !== "0x0000000000000000000000000000000000000000"
    ? ((await c.getBytecode({address:sub})) ?? "0x").length/2 - 1 : 0;
  console.log(`${label}.eth  owner=${owner}  registry=${sub ?? "-"}  code=${code}B`);
}
