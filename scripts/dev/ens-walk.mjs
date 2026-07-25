import { createPublicClient, http, namehash } from "viem";
import { sepolia } from "viem/chains";
process.loadEnvFile("/home/ubuntu/projects/lisboa/.env");
const c = createPublicClient({ chain: sepolia, transport: http(process.env.ETH_SEPOLIA_RPC) });
const ETH="0xDEDB92913A25abE1f7BCDD85D8A344a43B398B67";
const RES="0x211D6CC339C7C6E4B4448c04cD034E363d9994d3";
const reg=[{type:"function",name:"getSubregistry",stateMutability:"view",inputs:[{name:"l",type:"string"}],outputs:[{type:"address"}]},
{type:"function",name:"getResolver",stateMutability:"view",inputs:[{name:"l",type:"string"}],outputs:[{type:"address"}]},
{type:"function",name:"findOwner",stateMutability:"view",inputs:[{name:"l",type:"string"}],outputs:[{type:"address"}]},
{type:"function",name:"findExpiry",stateMutability:"view",inputs:[{name:"l",type:"string"}],outputs:[{type:"uint64"}]}];
const res=[{type:"function",name:"addr",stateMutability:"view",inputs:[{name:"n",type:"bytes32"}],outputs:[{type:"address"}]}];
const name = process.argv[2] || "carol.alice.aval.eth";
const labels = name.split(".").slice(0,-1).reverse(); // eth removed later
// name like carol.alice.aval.eth -> walk eth registry with "aval", then "alice", then "carol"
const parts = name.split(".");
if (parts.at(-1)!=="eth") throw new Error("expect .eth");
const walk = parts.slice(0,-1).reverse(); // [aval, alice, carol]
let cur = ETH, path="eth";
for (const l of walk){
  const owner = await c.readContract({address:cur,abi:reg,functionName:"findOwner",args:[l]});
  const r = await c.readContract({address:cur,abi:reg,functionName:"getResolver",args:[l]});
  const exp = await c.readContract({address:cur,abi:reg,functionName:"findExpiry",args:[l]});
  const sub = await c.readContract({address:cur,abi:reg,functionName:"getSubregistry",args:[l]});
  const code = sub==="0x0000000000000000000000000000000000000000"?"0x":await c.getCode({address:sub});
  path = l+"."+path;
  console.log(`${path.padEnd(26)} parentRegistry=${cur}`);
  console.log(`${" ".repeat(26)} owner=${owner} resolver=${r} expiry=${exp} (${new Date(Number(exp)*1000).toISOString()})`);
  console.log(`${" ".repeat(26)} getSubregistry("${l}")=${sub} code=${(code.length-2)/2}B`);
  cur = sub;
}
const a = await c.readContract({address:RES,abi:res,functionName:"addr",args:[namehash(name)]});
console.log(`resolver.addr(namehash("${name}")) = ${a}`);
